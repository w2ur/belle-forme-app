import net from "node:net";

/**
 * A throttle on failed logins.
 *
 * The password check is a bare SHA-256 compare, fast by design of the hash, so
 * what stands between an attacker and a guessable passphrase is how many guesses
 * they get. This caps them: after MAX_FAILED_ATTEMPTS wrong passwords from one
 * address inside WINDOW_MINUTES, that address is refused until the window
 * empties, correct password or not.
 *
 * The attempt is RECORDED BEFORE it is judged. A check-then-record throttle lets
 * a parallel burst read "under the limit" N times before any of them writes, so
 * the burst gets N guesses. Here every request first commits its own row, then
 * counts the rows in the window; a request's count therefore includes every
 * request that committed before it, and at most MAX_FAILED_ATTEMPTS requests can
 * ever count <= the limit, however they interleave. A refused request deletes
 * its own row (a hammering client must not keep its own lock alive), a correct
 * password clears the address.
 *
 * Per address, not global, so a stranger hammering the endpoint cannot lock the
 * owner out of their own app. The address is the one Netlify's edge stamps on
 * the request (`x-nf-client-connection-ip`); a request without it shares one
 * "unknown" bucket rather than escaping the throttle, and an IPv6 address is
 * bucketed by its /64, the smallest block one subscriber normally controls, so
 * rotating inside it does not reset the count.
 *
 * It lives in Postgres because a function holds no state between invocations.
 * Callers treat a database failure as "not throttled" and log it: an instance
 * that has not applied the `login_attempts` table yet must still let its owner
 * in. The throttle is a brake on guessing, not the boundary — the passphrase is.
 */

export const MAX_FAILED_ATTEMPTS = 5;
export const WINDOW_MINUTES = 15;

/** The first four groups of an IPv6 address as "a:b:c:d::/64", or null if it is not one. */
function ipv6Prefix64(address) {
  const addr = address.split("%")[0];
  if (!net.isIPv6(addr)) return null;
  let text = addr.toLowerCase();
  // A dotted IPv4 tail (::ffff:203.0.113.9) is two groups; an IPv4-mapped address IS the IPv4 client.
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    if (text.startsWith("::ffff:")) return tail[1];
    const [a, b, c, d] = tail[1].split(".").map(Number);
    text = text.slice(0, -tail[1].length) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head, rest] = text.split("::");
  const headGroups = head ? head.split(":") : [];
  const restGroups = rest === undefined ? [] : rest ? rest.split(":") : [];
  const missing = 8 - headGroups.length - restGroups.length;
  const groups = rest === undefined ? headGroups : [...headGroups, ...Array(missing).fill("0"), ...restGroups];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** The caller's address as Netlify reports it (IPv6 reduced to its /64), or the shared bucket "unknown". */
export function clientIp(headers) {
  const raw = headers?.["x-nf-client-connection-ip"] ?? headers?.["X-Nf-Client-Connection-Ip"];
  if (typeof raw !== "string" || !raw.trim()) return "unknown";
  const trimmed = raw.trim();
  return ipv6Prefix64(trimmed) ?? trimmed.slice(0, 64);
}

/**
 * Records one attempt from this address and says how many the address has inside
 * the window, this one included. Two autocommitted statements on purpose: see the
 * header for why the order, not a lock, is what makes a burst safe. Also sweeps
 * rows too old to matter.
 *
 * @returns {Promise<{ id: number, count: number }>}
 */
export async function beginAttempt(sql, ip) {
  const [inserted] = await sql`INSERT INTO login_attempts (ip) VALUES (${ip}) RETURNING id`;
  const [counted] = await sql`
    SELECT COUNT(*)::int AS n FROM login_attempts
    WHERE ip = ${ip} AND created_at > NOW() - make_interval(mins => ${WINDOW_MINUTES})
  `;
  await sql`DELETE FROM login_attempts WHERE created_at < NOW() - INTERVAL '1 day'`;
  return { id: inserted.id, count: counted?.n ?? 0 };
}

/** Takes back an attempt that was refused rather than judged, so a locked address cannot extend its own lock. */
export async function dropAttempt(sql, id) {
  await sql`DELETE FROM login_attempts WHERE id = ${id}`;
}

/** A correct password clears the address's slate. */
export async function clearFailures(sql, ip) {
  await sql`DELETE FROM login_attempts WHERE ip = ${ip}`;
}
