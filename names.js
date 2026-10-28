// Names on the solo leaderboard are public, so one with a swear word or a slur in it shows there as "Player" (see
// solo.js). It's still kept as typed, so the admin page can show who it was. Numbers and symbols standing in for
// letters count (a55, sh!t), and so do words split up with spaces, dots or dashes.

// Rude wherever they turn up in a name
const ANYWHERE = [
  'fuck', 'shit', 'cunt', 'bitch', 'whore', 'slut', 'nigger', 'nigga', 'faggot', 'pussy', 'penis', 'vagina',
  'dildo', 'porn', 'nazi', 'hitler', 'retard', 'twat', 'jizz', 'asshole', 'arsehole', 'bastard', 'bollock',
  'wanker', 'cumshot', 'blowjob', 'handjob', 'tranny', 'molest', 'pedophile', 'incest', 'orgasm', 'titties',
  'sperm', 'fellatio', 'masturbat', 'milf', 'wetback', 'dickhead', 'butthole', 'piss', 'killyourself', 'terrorist',
];

// Only on their own, since ordinary names have them inside (Cassandra, Dickens, Hancock, Titus, Essex, therapist...)
const ALONE = [
  'ass', 'arse', 'cock', 'cocks', 'dick', 'dicks', 'tits', 'tit', 'boobs', 'anus', 'anal', 'semen', 'sex', 'sexy',
  'rape', 'raping', 'rapist', 'pedo', 'horny', 'boner', 'clit', 'cuck', 'chink', 'spic', 'kike', 'gook', 'coon',
  'dyke', 'fag', 'fags', 'homo', 'kys',
];

const LOOKALIKES = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't' };

function isRude(name) {
  const plain = String(name).toLowerCase().replace(/[0134578@$!|+]/g, (c) => LOOKALIKES[c]);
  const squashed = plain.replace(/[^a-z]/g, '');
  const words = plain.split(/[^a-z]+/).filter(Boolean);
  return ANYWHERE.some(rude => squashed.includes(rude)) || ALONE.some(rude => squashed === rude || words.includes(rude));
}

module.exports = { isRude };
