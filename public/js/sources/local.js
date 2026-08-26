export async function fetchLibrary() {
  const response = await fetch('/api/library');
  if (!response.ok) {
    throw new Error(`Failed to fetch library: ${response.status}`);
  }
  return response.json();
}

export function streamUrl(trackId) {
  return `/audio/${encodeURIComponent(trackId)}`;
}
