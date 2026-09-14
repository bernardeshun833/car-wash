const KEY_LENGTH_BITS = 256;

export const DEFAULT_PIN_ITERATIONS = 200_000;

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// The explicit ArrayBuffer parameter matters: WebCrypto wants a view backed by
// a plain ArrayBuffer, and the unparameterised Uint8Array admits SharedArrayBuffer.
function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export async function hashPin(
  pin: string,
  saltHex: string,
  iterations: number = DEFAULT_PIN_ITERATIONS
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: fromHex(saltHex), iterations, hash: "SHA-256" },
    key,
    KEY_LENGTH_BITS
  );
  return toHex(bits);
}

export function generateSalt(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(8)).buffer);
}

// Constant-time comparison. The PIN space is only 10^4, so this does not make
// PIN verification secure on a stolen device — it just avoids handing a timing
// oracle to anything running in the same browser.
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function verifyPin(
  pin: string,
  attendant: { pin_hash: string; pin_salt: string; pin_iterations: number }
): Promise<boolean> {
  const candidate = await hashPin(pin, attendant.pin_salt, attendant.pin_iterations);
  return constantTimeEquals(candidate, attendant.pin_hash);
}
