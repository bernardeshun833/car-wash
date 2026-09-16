import { describe, expect, it } from "vitest";
import { monthRange, readable } from "../src/lib/owner.ts";

/**
 * The parts of the owner history that are worth testing without a database.
 *
 * Everything else in owner.ts is a thin call to a Postgres function that
 * checks the PIN itself, and the thing worth verifying about those — that the
 * PIN is never checked here — is a property of where the code lives, not
 * something a unit test can assert.
 */

describe("monthRange", () => {
  it("covers a whole month", () => {
    expect(monthRange(2026, 8)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("gets 31-day months right", () => {
    expect(monthRange(2026, 0)).toEqual({ from: "2026-01-01", to: "2026-01-31" });
  });

  it("gets February right in a leap year", () => {
    expect(monthRange(2024, 1)).toEqual({ from: "2024-02-01", to: "2024-02-29" });
  });

  it("gets February right outside one", () => {
    expect(monthRange(2026, 1)).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("is built in UTC, so the reader's own timezone cannot shift the month", () => {
    // The owner may be anywhere. A local-time `new Date(y, m, 1)` west of
    // Greenwich lands on the last day of the previous month, which would ask
    // the database for the wrong range and quietly show the wrong figures.
    const range = monthRange(2026, 5);
    expect(range.from).toBe("2026-06-01");
    expect(range.from.slice(0, 7)).toBe(range.to.slice(0, 7));
  });

  it("pads single-digit months and days", () => {
    expect(monthRange(2026, 2)).toEqual({ from: "2026-03-01", to: "2026-03-31" });
  });
});

describe("readable", () => {
  it("turns the lockout into an instruction with a time", () => {
    expect(readable('LOCKED_UNTIL 14:30')).toBe(
      "Too many wrong PINs. Try again after 14:30."
    );
  });

  it("says plainly when the PIN is wrong", () => {
    expect(readable("WRONG_PIN")).toBe("That PIN is not right");
  });

  it("points at the setup step when no owner PIN exists yet", () => {
    expect(readable("NO_OWNER_PIN")).toContain("No owner PIN has been set");
  });

  it("passes anything else through rather than swallowing it", () => {
    // An unrecognised database error is more useful verbatim than replaced
    // with a friendly guess about what went wrong.
    expect(readable("could not connect to server")).toBe("could not connect to server");
  });
});
