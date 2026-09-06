// supabase/functions/_shared/pubsub.ts
// Best-effort Pub/Sub publisher for edge functions (non-blocking wake-up hints).

export async function publishBestEffort(
  topic: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const gcpProjectId = Deno.env.get("GCP_PROJECT_ID");
  const gcpSaJson = Deno.env.get("GCP_SERVICE_ACCOUNT_JSON");
  const topicName = Deno.env.get("GCP_PUBSUB_TOPIC") || topic;

  if (!gcpProjectId || !gcpSaJson) {
    // Non-blocking fallback: worker self-heal loop sweeps queued notification_jobs every 20s
    console.log(`[pubsub-fallback] Queued event for topic '${topicName}':`, JSON.stringify(payload));
    return true;
  }

  try {
    const creds = JSON.parse(gcpSaJson);
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const claim = {
      iss: creds.client_email,
      scope: "https://www.googleapis.com/auth/pubsub",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now,
    };

    // If running in standard edge environments without native node crypto, or during tests:
    const msgData = btoa(JSON.stringify(payload));
    const endpoint = `https://pubsub.googleapis.com/v1/projects/${gcpProjectId}/topics/${topicName}:publish`;

    // Fire & forget with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1500);

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ data: msgData, attributes: { origin: "surge-router" } }],
      }),
      signal: controller.signal,
    }).catch((err) => {
      console.warn("[pubsub-warn] Pub/Sub HTTP error (worker self-heal loop will recover):", err.message);
      return null;
    });

    clearTimeout(timeoutId);
    return res ? res.ok : false;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[pubsub-error] Non-fatal Pub/Sub error:", message);
    return false;
  }
}
