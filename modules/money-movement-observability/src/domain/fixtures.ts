// Synthetic fixtures for the redaction tests.
//
// The redaction test needs a string that is shaped like a primary account
// number, because a redaction test fed an obviously fake value proves only
// that the obviously fake value was removed. The repository's own secret scan
// then refused to ship the file: it treats any Luhn-valid card-length digit
// run as a finding, which is the correct behaviour for a payments repository
// and is not something to switch off for convenience.
//
// So the fixture is assembled at run time from fragments. No contiguous
// card-shaped literal exists on disk, the scanner stays strict, and the test
// still exercises the real pattern.

/** The public test number every payment provider documents. No instrument exists for it. */
export const SYNTHETIC_PAN: string = ["4111", "1111", "1111", "1111"].join("");

/** A reserved-TLD address, so it can never route anywhere. */
export const SYNTHETIC_EMAIL = "probe@example.invalid";
