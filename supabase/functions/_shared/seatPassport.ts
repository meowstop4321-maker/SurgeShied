// supabase/functions/_shared/seatPassport.ts
// Issues and verifies HMAC-SHA256 signed Seat Passports (temporary reservation claims).

export type SeatPassportPayload = {
  eventId: string;
  userId: string;
  registrationId: string;
  laneIndex: number;
  exp: number;
  nonce: string;
};

function base64UrlEncode(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  return atob(base64);
}

export async function issueSeatPassport(
  payload: SeatPassportPayload,
  secret: string,
): Promise<string> {
  const header = { alg: "HS256", typ: "SEAT_PASSPORT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const data = `${encodedHeader}.${encodedPayload}`;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret || "default-surgeshield-secret-dev-key"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  const signatureBytes = new Uint8Array(signatureBuffer);
  let binary = "";
  for (let i = 0; i < signatureBytes.length; i++) {
    binary += String.fromCharCode(signatureBytes[i]);
  }
  const encodedSignature = base64UrlEncode(binary);

  return `${data}.${encodedSignature}`;
}

export async function verifySeatPassport(
  token: string,
  secret: string,
): Promise<{ valid: boolean; payload?: SeatPassportPayload; reason?: string }> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return { valid: false, reason: "invalid format" };

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const data = `${encodedHeader}.${encodedPayload}`;

    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret || "default-surgeshield-secret-dev-key"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );

    const signatureDecoded = base64UrlDecode(encodedSignature);
    const signatureBytes = new Uint8Array(signatureDecoded.length);
    for (let i = 0; i < signatureDecoded.length; i++) {
      signatureBytes[i] = signatureDecoded.charCodeAt(i);
    }

    const isValid = await crypto.subtle.verify("HMAC", key, signatureBytes, enc.encode(data));
    if (!isValid) return { valid: false, reason: "signature mismatch" };

    const payload: SeatPassportPayload = JSON.parse(base64UrlDecode(encodedPayload));
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return { valid: false, reason: "passport expired", payload };
    }

    return { valid: true, payload };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, reason: `decode error: ${message}` };
  }
}
