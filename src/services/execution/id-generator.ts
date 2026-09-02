export function clientOrderIdFor(decisionId: string): string {
  return `cID-${decisionId}`;
}

export function decisionIdFromClientOrderId(clientOrderId: string): string | null {
  if (!clientOrderId.startsWith('cID-')) return null;
  return clientOrderId.slice(4);
}
