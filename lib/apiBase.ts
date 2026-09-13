/**
 * Frontend API base URL.
 *
 * Local development keeps the paper-friendly localhost default. Production
 * must receive an explicit API URL; otherwise requests stay same-origin and
 * fail closed instead of probing a user's localhost service.
 */
function resolveApiBase(): string {
  const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (!configuredApiUrl) {
    return process.env.NODE_ENV === "development" ? "http://localhost:8000" : "";
  }

  try {
    const apiUrl = new URL(configuredApiUrl);
    if (apiUrl.protocol !== "http:" && apiUrl.protocol !== "https:") return "";
    return configuredApiUrl.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export const API_BASE = resolveApiBase();
