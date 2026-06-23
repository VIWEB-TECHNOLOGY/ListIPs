const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function randomToken(prefix = 'sec_', bytes = 24): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return `${prefix}${base64Url(buffer)}`;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Label(value: string): Promise<string> {
  return `sha256:${await sha256Hex(value)}`;
}

export async function encryptSecret(value: string, secret: string): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await aesKey(secret);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(value));
  return `v1:${base64Url(iv)}:${base64Url(new Uint8Array(encrypted))}`;
}

export async function decryptSecret(value: string, secret: string): Promise<string | null> {
  const [version, rawIv, rawEncrypted] = value.split(':');
  if (version !== 'v1' || !rawIv || !rawEncrypted) return null;

  try {
    const key = await aesKey(secret);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64UrlDecode(rawIv) },
      key,
      base64UrlDecode(rawEncrypted)
    );
    return decoder.decode(decrypted);
  } catch {
    return null;
  }
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.byteLength !== right.byteLength) return false;

  let result = 0;
  for (let i = 0; i < left.byteLength; i += 1) {
    result |= left[i] ^ right[i];
  }

  return result === 0;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function base64UrlDecode(value: string): ArrayBuffer {
  const padded = `${value}${'='.repeat((4 - value.length % 4) % 4)}`;
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}
