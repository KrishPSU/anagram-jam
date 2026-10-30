// Makes the client secret Supabase needs for Sign in with Apple. Apple doesn't hand one out: it's a token (a JWT) that
// you sign yourself with the key from developer.apple.com (Keys -> a key with Sign in with Apple on it -> the
// AuthKey_XXXXXXXXXX.p8 file it lets you download once), and Apple only accepts it for 6 months, so it has to be made
// again twice a year. SETUP-ACCOUNTS.md has the whole setup and where this goes: Supabase -> Authentication ->
// Providers -> Apple -> Secret Key.
//
//   node scripts/apple-secret.js --key ~/Downloads/AuthKey_ABC123DEFG.p8 --key-id ABC123DEFG --team-id UXXL68D688 --client-id com.krishchavan.anagramjam.web
//   node scripts/apple-secret.js --key ~/Downloads/AuthKey_ABC123DEFG.p8 | pbcopy    the same, straight to the clipboard
//
// --key-id can be left out while the file still has the name Apple gave it (AuthKey_<key id>.p8). --team-id and
// --client-id default to Anagram Jam's: the team is UXXL68D688 (the one that signs the iPhone app too), and the client
// is the Services ID com.krishchavan.anagramjam.web - a website's "app" to Apple, which is what players sign in
// through, in the iPhone app as well, since the app shows the site. Only the token goes to stdout, so it can be piped;
// what it's for and when it expires go to stderr.
//
// The token is what Apple's "Creating a client secret" page asks for: header { alg: 'ES256', kid: the key id }, payload
// { iss: the team id, iat: now, exp: 180 days from now (Apple's most is 6 months), aud: https://appleid.apple.com,
// sub: the client id }, signed with the key - ECDSA over P-256 with SHA-256, the signature as the 64 raw bytes (r then
// s) that JWTs use rather than the DER that OpenSSL would give. Only Node's own crypto: no dependencies, nothing
// leaves this machine, and the key file isn't changed.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DAYS = 180; // Apple accepts an exp up to 15777000 seconds (6 months) ahead; 180 days keeps a few days clear of it
const AUDIENCE = 'https://appleid.apple.com';
const DEFAULTS = { 'team-id': 'UXXL68D688', 'client-id': 'com.krishchavan.anagramjam.web' };
const FLAGS = ['key', 'key-id', 'team-id', 'client-id'];

const USAGE = `Usage: node scripts/apple-secret.js --key AuthKey_XXXXXXXXXX.p8 [--key-id XXXXXXXXXX] [--team-id ${DEFAULTS['team-id']}] [--client-id ${DEFAULTS['client-id']}]

  --key        the .p8 file from developer.apple.com -> Keys (a key with Sign in with Apple on it)
  --key-id     its Key ID, the 10 characters shown next to the key there; read off the file's name while it's still AuthKey_<key id>.p8
  --team-id    the Apple Developer team (default ${DEFAULTS['team-id']})
  --client-id  the Services ID the website signs in as (default ${DEFAULTS['client-id']})

Prints the client secret for Supabase's Apple provider (Authentication -> Providers -> Apple -> Secret Key). It's good for ${DAYS} days.`;

// Something wrong with how it was called, as opposed to with the key: the usage goes out with the message
class UsageError extends Error {}

// --name value or --name=value, in any order
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') return { help: true };
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!match || !FLAGS.includes(match[1])) throw new UsageError(`Didn't expect "${argv[i]}"`);
    const value = match[2] !== undefined ? match[2] : argv[++i];
    if (value === undefined || value === '') throw new UsageError(`--${match[1]} needs a value`);
    args[match[1]] = value;
  }
  return args;
}

const base64url = (data) => Buffer.from(data).toString('base64url');

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (!args.key) throw new UsageError('Needs --key, the .p8 file');
  // Apple names the download AuthKey_<key id>.p8, so the id is usually right there
  const named = /^AuthKey_([A-Z0-9]+)\.p8$/i.exec(path.basename(args.key));
  const keyId = args['key-id'] || (named && named[1]);
  if (!keyId) throw new UsageError(`Needs --key-id: ${path.basename(args.key)} isn't named AuthKey_<key id>.p8, so the Key ID can't be read off it`);
  const teamId = args['team-id'] || DEFAULTS['team-id'];
  const clientId = args['client-id'] || DEFAULTS['client-id'];

  let key;
  try {
    key = crypto.createPrivateKey(fs.readFileSync(args.key, 'utf8'));
  } catch (err) {
    throw new Error(`Couldn't read a private key from ${args.key}: ${err.message}`);
  }
  // Apple's keys are EC P-256 (prime256v1), the only kind ES256 can sign with
  const curve = (key.asymmetricKeyDetails || {}).namedCurve;
  if (key.asymmetricKeyType !== 'ec' || curve !== 'prime256v1') {
    throw new Error(`${args.key} isn't a Sign in with Apple key: expected an EC P-256 private key, got ${key.asymmetricKeyType}${curve ? ` (${curve})` : ''}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: keyId };
  const payload = { iss: teamId, iat: now, exp: now + DAYS * 24 * 60 * 60, aud: AUDIENCE, sub: clientId };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  const token = `${signingInput}.${base64url(signature)}`;

  const expires = new Date(payload.exp * 1000).toISOString().slice(0, 10);
  console.error(`Client secret for ${clientId} (team ${teamId}, key ${keyId}), good until ${expires} - put a reminder in the calendar for a week before that.`);
  console.log(token);
}

try {
  main();
} catch (err) {
  console.error(err.message);
  if (err instanceof UsageError) console.error(`\n${USAGE}`);
  process.exit(1);
}
