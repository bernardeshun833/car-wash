/**
 * Client-generated row ids.
 *
 * These double as the Postgres primary key, which is what makes a retry
 * idempotent: a re-sent row collides instead of creating a duplicate wash.
 *
 * `crypto.randomUUID` is the right tool and is what runs almost everywhere.
 * But it is not universal — it needs a secure context, it arrived late in some
 * mobile browsers, and privacy-hardened browsers have been known to withhold
 * bits of the crypto surface. When it is missing, calling it throws a
 * TypeError from inside the object literal being saved, which used to mean the
 * wash simply never recorded and the screen did nothing at all.
 *
 * A POS on a phone in a wash yard cannot be the place we find that out, so
 * this degrades instead: a proper v4 UUID from getRandomValues where possible,
 * and a clearly-marked last resort where even that is unavailable. Every path
 * returns something unique enough to be a primary key, which is the only
 * property the id actually needs — these are not secrets and nothing is
 * derived from them.
 */

function v4FromBytes(bytes: Uint8Array): string {
  // Set the version and variant bits, per RFC 4122.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ].join("-");
}

export function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;

  if (c && typeof c.randomUUID === "function") {
    try {
      return c.randomUUID();
    } catch {
      // Fall through — a browser that exposes it but refuses to run it.
    }
  }

  if (c && typeof c.getRandomValues === "function") {
    try {
      return v4FromBytes(c.getRandomValues(new Uint8Array(16)));
    } catch {
      // Fall through.
    }
  }

  // No usable randomness source. Still unique in practice — time plus two
  // random segments — and a duplicate would only collide with another row
  // created in the same millisecond on the same device.
  const rand = () => Math.random().toString(16).slice(2, 10).padStart(8, "0");
  const bytes = new Uint8Array(16);
  const seed = `${Date.now().toString(16).padStart(12, "0")}${rand()}${rand()}`;
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(seed.slice(i * 2, i * 2 + 2) || "0", 16);
  }
  return v4FromBytes(bytes);
}
