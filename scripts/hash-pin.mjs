#!/usr/bin/env node
// Generate a PIN hash + salt for an attendant row.
//   node scripts/hash-pin.mjs 1234
//   node scripts/hash-pin.mjs 1234 <existing-salt-hex>

const ITERATIONS = 200_000;

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

const pin = process.argv[2];
if (!pin) {
  console.error("usage: node scripts/hash-pin.mjs <pin> [salt-hex]");
  process.exit(1);
}

const saltHex = process.argv[3] ?? toHex(crypto.getRandomValues(new Uint8Array(8)).buffer);

const key = await crypto.subtle.importKey(
  "raw",
  new TextEncoder().encode(pin),
  "PBKDF2",
  false,
  ["deriveBits"]
);
const bits = await crypto.subtle.deriveBits(
  { name: "PBKDF2", salt: fromHex(saltHex), iterations: ITERATIONS, hash: "SHA-256" },
  key,
  256
);

console.log(
  JSON.stringify(
    { pin_hash: toHex(bits), pin_salt: saltHex, pin_iterations: ITERATIONS },
    null,
    2
  )
);
