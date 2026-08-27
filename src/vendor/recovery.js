'use strict';
/* YayLayer recovery — BIP39 mnemonic + SLIP-0010(ed25519) key derivation, PURE JS.
 *
 * Lives ONLY on the phone (and in Node for tests). The laptop never sees the
 * mnemonic or the private key — only the derived public key + signatures, exactly
 * like the live signer. Built on TweetNaCl's SHA-512 (nacl.hash) so it needs no
 * WebCrypto/secure-context and works over plain http.
 *
 * Pipeline: 256-bit entropy → 24-word BIP39 mnemonic (SHA-256 checksum) →
 * PBKDF2-HMAC-SHA512(2048) seed → SLIP-0010 "ed25519 seed" master → 32-byte
 * ed25519 seed → nacl.sign.keyPair.fromSeed. Restoring the same words on any
 * device reproduces the identical keypair (same public key → still trusted, no
 * re-seal). The wordlist is the canonical BIP39 English list (sha256
 * 2f5eed53…3b24dbda); a wrong/mistyped word fails the checksum.
 */
(function () {
  var nacl = (typeof window !== 'undefined' && window.nacl) ||
    (typeof global !== 'undefined' && global.nacl) ||
    (typeof require === 'function' ? require('./tweetnacl.min.js') : null);
  if (!nacl) throw new Error('recovery.js needs TweetNaCl (nacl) loaded first');

  var WORDS = "abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual adapt add addict address adjust admit adult advance advice aerobic affair afford afraid again age agent agree ahead aim air airport aisle alarm album alcohol alert alien all alley allow almost alone alpha already also alter always amateur amazing among amount amused analyst anchor ancient anger angle angry animal ankle announce annual another answer antenna antique anxiety any apart apology appear apple approve april arch arctic area arena argue arm armed armor army around arrange arrest arrive arrow art artefact artist artwork ask aspect assault asset assist assume asthma athlete atom attack attend attitude attract auction audit august aunt author auto autumn average avocado avoid awake aware away awesome awful awkward axis baby bachelor bacon badge bag balance balcony ball bamboo banana banner bar barely bargain barrel base basic basket battle beach bean beauty because become beef before begin behave behind believe below belt bench benefit best betray better between beyond bicycle bid bike bind biology bird birth bitter black blade blame blanket blast bleak bless blind blood blossom blouse blue blur blush board boat body boil bomb bone bonus book boost border boring borrow boss bottom bounce box boy bracket brain brand brass brave bread breeze brick bridge brief bright bring brisk broccoli broken bronze broom brother brown brush bubble buddy budget buffalo build bulb bulk bullet bundle bunker burden burger burst bus business busy butter buyer buzz cabbage cabin cable cactus cage cake call calm camera camp can canal cancel candy cannon canoe canvas canyon capable capital captain car carbon card cargo carpet carry cart case cash casino castle casual cat catalog catch category cattle caught cause caution cave ceiling celery cement census century cereal certain chair chalk champion change chaos chapter charge chase chat cheap check cheese chef cherry chest chicken chief child chimney choice choose chronic chuckle chunk churn cigar cinnamon circle citizen city civil claim clap clarify claw clay clean clerk clever click client cliff climb clinic clip clock clog close cloth cloud clown club clump cluster clutch coach coast coconut code coffee coil coin collect color column combine come comfort comic common company concert conduct confirm congress connect consider control convince cook cool copper copy coral core corn correct cost cotton couch country couple course cousin cover coyote crack cradle craft cram crane crash crater crawl crazy cream credit creek crew cricket crime crisp critic crop cross crouch crowd crucial cruel cruise crumble crunch crush cry crystal cube culture cup cupboard curious current curtain curve cushion custom cute cycle dad damage damp dance danger daring dash daughter dawn day deal debate debris decade december decide decline decorate decrease deer defense define defy degree delay deliver demand demise denial dentist deny depart depend deposit depth deputy derive describe desert design desk despair destroy detail detect develop device devote diagram dial diamond diary dice diesel diet differ digital dignity dilemma dinner dinosaur direct dirt disagree discover disease dish dismiss disorder display distance divert divide divorce dizzy doctor document dog doll dolphin domain donate donkey donor door dose double dove draft dragon drama drastic draw dream dress drift drill drink drip drive drop drum dry duck dumb dune during dust dutch duty dwarf dynamic eager eagle early earn earth easily east easy echo ecology economy edge edit educate effort egg eight either elbow elder electric elegant element elephant elevator elite else embark embody embrace emerge emotion employ empower empty enable enact end endless endorse enemy energy enforce engage engine enhance enjoy enlist enough enrich enroll ensure enter entire entry envelope episode equal equip era erase erode erosion error erupt escape essay essence estate eternal ethics evidence evil evoke evolve exact example excess exchange excite exclude excuse execute exercise exhaust exhibit exile exist exit exotic expand expect expire explain expose express extend extra eye eyebrow fabric face faculty fade faint faith fall false fame family famous fan fancy fantasy farm fashion fat fatal father fatigue fault favorite feature february federal fee feed feel female fence festival fetch fever few fiber fiction field figure file film filter final find fine finger finish fire firm first fiscal fish fit fitness fix flag flame flash flat flavor flee flight flip float flock floor flower fluid flush fly foam focus fog foil fold follow food foot force forest forget fork fortune forum forward fossil foster found fox fragile frame frequent fresh friend fringe frog front frost frown frozen fruit fuel fun funny furnace fury future gadget gain galaxy gallery game gap garage garbage garden garlic garment gas gasp gate gather gauge gaze general genius genre gentle genuine gesture ghost giant gift giggle ginger giraffe girl give glad glance glare glass glide glimpse globe gloom glory glove glow glue goat goddess gold good goose gorilla gospel gossip govern gown grab grace grain grant grape grass gravity great green grid grief grit grocery group grow grunt guard guess guide guilt guitar gun gym habit hair half hammer hamster hand happy harbor hard harsh harvest hat have hawk hazard head health heart heavy hedgehog height hello helmet help hen hero hidden high hill hint hip hire history hobby hockey hold hole holiday hollow home honey hood hope horn horror horse hospital host hotel hour hover hub huge human humble humor hundred hungry hunt hurdle hurry hurt husband hybrid ice icon idea identify idle ignore ill illegal illness image imitate immense immune impact impose improve impulse inch include income increase index indicate indoor industry infant inflict inform inhale inherit initial inject injury inmate inner innocent input inquiry insane insect inside inspire install intact interest into invest invite involve iron island isolate issue item ivory jacket jaguar jar jazz jealous jeans jelly jewel job join joke journey joy judge juice jump jungle junior junk just kangaroo keen keep ketchup key kick kid kidney kind kingdom kiss kit kitchen kite kitten kiwi knee knife knock know lab label labor ladder lady lake lamp language laptop large later latin laugh laundry lava law lawn lawsuit layer lazy leader leaf learn leave lecture left leg legal legend leisure lemon lend length lens leopard lesson letter level liar liberty library license life lift light like limb limit link lion liquid list little live lizard load loan lobster local lock logic lonely long loop lottery loud lounge love loyal lucky luggage lumber lunar lunch luxury lyrics machine mad magic magnet maid mail main major make mammal man manage mandate mango mansion manual maple marble march margin marine market marriage mask mass master match material math matrix matter maximum maze meadow mean measure meat mechanic medal media melody melt member memory mention menu mercy merge merit merry mesh message metal method middle midnight milk million mimic mind minimum minor minute miracle mirror misery miss mistake mix mixed mixture mobile model modify mom moment monitor monkey monster month moon moral more morning mosquito mother motion motor mountain mouse move movie much muffin mule multiply muscle museum mushroom music must mutual myself mystery myth naive name napkin narrow nasty nation nature near neck need negative neglect neither nephew nerve nest net network neutral never news next nice night noble noise nominee noodle normal north nose notable note nothing notice novel now nuclear number nurse nut oak obey object oblige obscure observe obtain obvious occur ocean october odor off offer office often oil okay old olive olympic omit once one onion online only open opera opinion oppose option orange orbit orchard order ordinary organ orient original orphan ostrich other outdoor outer output outside oval oven over own owner oxygen oyster ozone pact paddle page pair palace palm panda panel panic panther paper parade parent park parrot party pass patch path patient patrol pattern pause pave payment peace peanut pear peasant pelican pen penalty pencil people pepper perfect permit person pet phone photo phrase physical piano picnic picture piece pig pigeon pill pilot pink pioneer pipe pistol pitch pizza place planet plastic plate play please pledge pluck plug plunge poem poet point polar pole police pond pony pool popular portion position possible post potato pottery poverty powder power practice praise predict prefer prepare present pretty prevent price pride primary print priority prison private prize problem process produce profit program project promote proof property prosper protect proud provide public pudding pull pulp pulse pumpkin punch pupil puppy purchase purity purpose purse push put puzzle pyramid quality quantum quarter question quick quit quiz quote rabbit raccoon race rack radar radio rail rain raise rally ramp ranch random range rapid rare rate rather raven raw razor ready real reason rebel rebuild recall receive recipe record recycle reduce reflect reform refuse region regret regular reject relax release relief rely remain remember remind remove render renew rent reopen repair repeat replace report require rescue resemble resist resource response result retire retreat return reunion reveal review reward rhythm rib ribbon rice rich ride ridge rifle right rigid ring riot ripple risk ritual rival river road roast robot robust rocket romance roof rookie room rose rotate rough round route royal rubber rude rug rule run runway rural sad saddle sadness safe sail salad salmon salon salt salute same sample sand satisfy satoshi sauce sausage save say scale scan scare scatter scene scheme school science scissors scorpion scout scrap screen script scrub sea search season seat second secret section security seed seek segment select sell seminar senior sense sentence series service session settle setup seven shadow shaft shallow share shed shell sheriff shield shift shine ship shiver shock shoe shoot shop short shoulder shove shrimp shrug shuffle shy sibling sick side siege sight sign silent silk silly silver similar simple since sing siren sister situate six size skate sketch ski skill skin skirt skull slab slam sleep slender slice slide slight slim slogan slot slow slush small smart smile smoke smooth snack snake snap sniff snow soap soccer social sock soda soft solar soldier solid solution solve someone song soon sorry sort soul sound soup source south space spare spatial spawn speak special speed spell spend sphere spice spider spike spin spirit split spoil sponsor spoon sport spot spray spread spring spy square squeeze squirrel stable stadium staff stage stairs stamp stand start state stay steak steel stem step stereo stick still sting stock stomach stone stool story stove strategy street strike strong struggle student stuff stumble style subject submit subway success such sudden suffer sugar suggest suit summer sun sunny sunset super supply supreme sure surface surge surprise surround survey suspect sustain swallow swamp swap swarm swear sweet swift swim swing switch sword symbol symptom syrup system table tackle tag tail talent talk tank tape target task taste tattoo taxi teach team tell ten tenant tennis tent term test text thank that theme then theory there they thing this thought three thrive throw thumb thunder ticket tide tiger tilt timber time tiny tip tired tissue title toast tobacco today toddler toe together toilet token tomato tomorrow tone tongue tonight tool tooth top topic topple torch tornado tortoise toss total tourist toward tower town toy track trade traffic tragic train transfer trap trash travel tray treat tree trend trial tribe trick trigger trim trip trophy trouble truck true truly trumpet trust truth try tube tuition tumble tuna tunnel turkey turn turtle twelve twenty twice twin twist two type typical ugly umbrella unable unaware uncle uncover under undo unfair unfold unhappy uniform unique unit universe unknown unlock until unusual unveil update upgrade uphold upon upper upset urban urge usage use used useful useless usual utility vacant vacuum vague valid valley valve van vanish vapor various vast vault vehicle velvet vendor venture venue verb verify version very vessel veteran viable vibrant vicious victory video view village vintage violin virtual virus visa visit visual vital vivid vocal voice void volcano volume vote voyage wage wagon wait walk wall walnut want warfare warm warrior wash wasp waste water wave way wealth weapon wear weasel weather web wedding weekend weird welcome west wet whale what wheat wheel when where whip whisper wide width wife wild will win window wine wing wink winner winter wire wisdom wise wish witness wolf woman wonder wood wool word work world worry worth wrap wreck wrestle wrist write wrong yard year yellow you young youth zebra zero zone zoo".split(" ");
  if (WORDS.length !== 2048) throw new Error('BIP39 wordlist must have 2048 words, got ' + WORDS.length);
  var SPKI = new Uint8Array([48, 42, 48, 5, 6, 3, 43, 101, 112, 3, 33, 0]); // ed25519 SPKI header

  // ── encodings ────────────────────────────────────────────
  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    return new Uint8Array(Buffer.from(str, 'utf8')); // node fallback
  }
  function b64(bytes) {
    if (typeof btoa === 'function') { var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
    return Buffer.from(bytes).toString('base64');
  }
  function concat(a, b) { var out = new Uint8Array(a.length + b.length); out.set(a, 0); out.set(b, a.length); return out; }

  // ── SHA-256 (pure JS; only used for the BIP39 checksum) ───
  var K256 = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  function sha256(msg) {
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var l = msg.length;
    var withLenLen = ((l + 8) >> 6 << 6) + 64; // padded length, multiple of 64
    var m = new Uint8Array(withLenLen);
    m.set(msg, 0); m[l] = 0x80;
    var bitLen = l * 8;
    // 64-bit big-endian length (high 32 bits assumed 0 for our small inputs)
    m[withLenLen - 4] = (bitLen >>> 24) & 0xff; m[withLenLen - 3] = (bitLen >>> 16) & 0xff;
    m[withLenLen - 2] = (bitLen >>> 8) & 0xff; m[withLenLen - 1] = bitLen & 0xff;
    var w = new Array(64);
    function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
    for (var off = 0; off < withLenLen; off += 64) {
      for (var i = 0; i < 16; i++) {
        w[i] = (m[off + i * 4] << 24) | (m[off + i * 4 + 1] << 16) | (m[off + i * 4 + 2] << 8) | (m[off + i * 4 + 3]);
      }
      for (i = 16; i < 64; i++) {
        var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K256[i] + w[i]) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var out = new Uint8Array(32);
    for (i = 0; i < 8; i++) { out[i * 4] = (H[i] >>> 24) & 0xff; out[i * 4 + 1] = (H[i] >>> 16) & 0xff; out[i * 4 + 2] = (H[i] >>> 8) & 0xff; out[i * 4 + 3] = H[i] & 0xff; }
    return out;
  }

  // ── HMAC-SHA512 / PBKDF2-HMAC-SHA512 (SHA-512 from nacl.hash) ─
  var BLK = 128; // SHA-512 block size
  function sha512(bytes) { return nacl.hash(bytes); } // Uint8Array(64)
  function hmacSha512(key, data) {
    if (key.length > BLK) key = sha512(key);
    var k = new Uint8Array(BLK); k.set(key, 0);
    var oPad = new Uint8Array(BLK), iPad = new Uint8Array(BLK);
    for (var i = 0; i < BLK; i++) { oPad[i] = k[i] ^ 0x5c; iPad[i] = k[i] ^ 0x36; }
    return sha512(concat(oPad, sha512(concat(iPad, data))));
  }
  function pbkdf2Sha512(pass, salt, iters, dkLen) {
    var hLen = 64, blocks = Math.ceil(dkLen / hLen), out = new Uint8Array(blocks * hLen);
    for (var b = 1; b <= blocks; b++) {
      var idx = new Uint8Array([(b >>> 24) & 0xff, (b >>> 16) & 0xff, (b >>> 8) & 0xff, b & 0xff]);
      var u = hmacSha512(pass, concat(salt, idx));
      var t = u.slice(0);
      for (var i = 1; i < iters; i++) { u = hmacSha512(pass, u); for (var j = 0; j < hLen; j++) t[j] ^= u[j]; }
      out.set(t, (b - 1) * hLen);
    }
    return out.slice(0, dkLen);
  }

  // ── BIP39 ────────────────────────────────────────────────
  function entropyToMnemonic(entropy) {
    if (entropy.length !== 16 && entropy.length !== 20 && entropy.length !== 24 && entropy.length !== 28 && entropy.length !== 32) {
      throw new Error('entropy must be 128–256 bits');
    }
    var cs = entropy.length * 8 / 32; // checksum bits
    var check = sha256(entropy);
    // build a bit string of entropy + checksum
    var bits = '';
    for (var i = 0; i < entropy.length; i++) bits += ('00000000' + entropy[i].toString(2)).slice(-8);
    var checkBits = '';
    for (i = 0; i < check.length; i++) checkBits += ('00000000' + check[i].toString(2)).slice(-8);
    bits += checkBits.slice(0, cs);
    var words = [];
    for (i = 0; i < bits.length; i += 11) words.push(WORDS[parseInt(bits.slice(i, i + 11), 2)]);
    return words.join(' ');
  }
  function normalizeMnemonic(mnemonic) {
    return String(mnemonic).normalize('NFKD').trim().replace(/\s+/g, ' ').toLowerCase();
  }
  function mnemonicToEntropy(mnemonic) {
    var words = normalizeMnemonic(mnemonic).split(' ');
    if ([12, 15, 18, 21, 24].indexOf(words.length) < 0) throw new Error('recovery phrase must be 12–24 words (got ' + words.length + ')');
    var bits = '';
    for (var i = 0; i < words.length; i++) {
      var idx = WORDS.indexOf(words[i]);
      if (idx < 0) throw new Error('not a valid recovery word: "' + words[i] + '"');
      bits += ('00000000000' + idx.toString(2)).slice(-11);
    }
    var csLen = bits.length / 33;      // checksum bits
    var entLen = bits.length - csLen;  // entropy bits
    var entropy = new Uint8Array(entLen / 8);
    for (i = 0; i < entropy.length; i++) entropy[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
    // verify checksum
    var check = sha256(entropy), checkBits = '';
    for (i = 0; i < check.length; i++) checkBits += ('00000000' + check[i].toString(2)).slice(-8);
    if (bits.slice(entLen) !== checkBits.slice(0, csLen)) throw new Error('recovery phrase checksum failed — a word is wrong or out of order');
    return entropy;
  }
  function mnemonicToSeed(mnemonic, passphrase) {
    var m = utf8(normalizeMnemonic(mnemonic));
    var salt = utf8('mnemonic' + String(passphrase || '').normalize('NFKD'));
    return pbkdf2Sha512(m, salt, 2048, 64);
  }

  // ── SLIP-0010 (ed25519): seed → 32-byte ed25519 private seed ─
  function seedToEd25519Seed(seed) {
    var I = hmacSha512(utf8('ed25519 seed'), seed);
    return I.slice(0, 32); // IL — the master private seed for ed25519
  }
  function keypairFromEd25519Seed(edSeed) {
    var kp = nacl.sign.keyPair.fromSeed(edSeed);
    var spki = concat(SPKI, kp.publicKey);
    return { pub: b64(spki), sec: b64(kp.secretKey) };
  }

  // Full pipeline: mnemonic (+ optional passphrase) → { pub(SPKI b64), sec(b64) }.
  function mnemonicToKeypair(mnemonic, passphrase) {
    mnemonicToEntropy(mnemonic); // validates checksum; throws on a bad phrase
    return keypairFromEd25519Seed(seedToEd25519Seed(mnemonicToSeed(mnemonic, passphrase)));
  }
  // Fresh 24-word phrase from a caller-supplied 32-byte entropy (crypto.getRandomValues on the phone).
  function newMnemonic(entropy32) {
    if (!entropy32 || entropy32.length !== 32) throw new Error('need 32 bytes of entropy for a 24-word phrase');
    return entropyToMnemonic(entropy32);
  }

  // ── PIN-encrypted keystore (at-rest protection for the phone key) ─
  // Seal the base64 secret key under a PIN with XSalsa20-Poly1305 (nacl.secretbox),
  // key = PBKDF2-HMAC-SHA512(pin). Only the ciphertext is stored; the plaintext key
  // never touches localStorage. NOTE: a short PIN is only casual protection — an
  // attacker who extracts the ciphertext can brute-force a low-entropy PIN offline
  // with native code; a longer passphrase (or the future enclave/WebAuthn layer) is
  // the real hardening. The 24-word phrase remains the master backup.
  function unb64(s) {
    if (typeof atob === 'function') { var bin = atob(s), a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
    return new Uint8Array(Buffer.from(s, 'base64'));
  }
  var KDF_ITERS = 50000;
  function sealSecret(secB64, pin, iters) {
    iters = iters || KDF_ITERS;
    var salt = nacl.randomBytes(16), nonce = nacl.randomBytes(24);
    var key = pbkdf2Sha512(utf8(String(pin)), salt, iters, 32);
    var ct = nacl.secretbox(unb64(secB64), nonce, key);
    return { ct: b64(ct), nonce: b64(nonce), salt: b64(salt), iters: iters };
  }
  function openSecret(enc, pin) {
    if (!enc || !enc.ct) return null;
    var key = pbkdf2Sha512(utf8(String(pin)), unb64(enc.salt), enc.iters || KDF_ITERS, 32);
    var out = nacl.secretbox.open(unb64(enc.ct), unb64(enc.nonce), key);
    return out ? b64(out) : null; // null = wrong PIN / tampered blob
  }

  // ── Sealed-box RECEIVE side (the phone/inbox): decrypt a request addressed to THIS
  // signer by converting its ed25519 SECRET to X25519 (matches e2e.js on the laptop).
  function b64url(u) { return b64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function edSecToX(edSec64) { var h = sha512(edSec64.subarray(0, 32)); var s = h.slice(0, 32); s[0] &= 248; s[31] &= 127; s[31] |= 64; return s; }
  // This signer's inbox channel — a public, deterministic hash of its (SPKI) public key.
  function inboxChannel(pubB64) { return b64url(sha512(utf8('yay-inbox:v1:' + pubB64)).subarray(0, 18)); }
  function openSealed(secB64, sealed) {
    try {
      var xsec = edSecToX(unb64(secB64));
      var m = nacl.box.open(unb64(sealed.c), unb64(sealed.n), unb64(sealed.epk), xsec);
      return m ? JSON.parse(new TextDecoder().decode(m)) : null;
    } catch (e) { return null; }
  }

  var R = { sha256: sha256, hmacSha512: hmacSha512, pbkdf2Sha512: pbkdf2Sha512, entropyToMnemonic: entropyToMnemonic, newMnemonic: newMnemonic, mnemonicToEntropy: mnemonicToEntropy, mnemonicToSeed: mnemonicToSeed, mnemonicToKeypair: mnemonicToKeypair, normalizeMnemonic: normalizeMnemonic, sealSecret: sealSecret, openSecret: openSecret, b64: b64, b64url: b64url, edSecToX: edSecToX, inboxChannel: inboxChannel, openSealed: openSealed };
  if (typeof module !== 'undefined' && module.exports) module.exports = R;
  if (typeof window !== 'undefined') window.YayRecovery = R;
})();
