export async function getPadLanguage(padId) {
  const response = await fetch(`${import.meta.env.VITE_PERSISTENCE_API_URL}/api/pads/${padId}`);
  const data = await response.json();
  if (response.status === 404) {
    throw new Error(data['error']);
  }
  return data['language'];
}

export function setPadLanguage(padId, language) {
  const body = { language: language };
  fetch(`${import.meta.env.VITE_PERSISTENCE_API_URL}/api/pads/${padId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

export async function getPadContents(padId, language) {
  let response = await fetch(`${import.meta.env.VITE_PERSISTENCE_API_URL}/api/pads/${padId}/content/${language}`);
  let content = await response.json();
  return content.content;
}

export function setPadContents(padId, language, content) {
  const body = { content: content };
  fetch(`${import.meta.env.VITE_PERSISTENCE_API_URL}/api/pads/${padId}/content/${language}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true  // Completes even after tab closes
  });
}