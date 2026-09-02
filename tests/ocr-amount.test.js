// The amount check used to have two outcomes, and "I could not read it" fell
// into the same bucket as "this says something else". Measured over the 190
// approved slips on the live instance, that put a red cross on 37 of them
// (20%) whose amounts were perfectly correct -- mostly Google Pay receipts in
// DARK MODE, where the amount is large light-grey text on near-black that
// Tesseract's default binarisation erases while still reading the smaller
// body text around it.
//
// The matcher is exercised for real: the two functions are lifted out of
// server.js and run. The OCR text below is synthetic, written to the shapes
// the real slips produce -- no delegate data belongs in this repo.
const { check, report, appFile } = require('./harness');
const fs = require('fs');

const src = fs.readFileSync(appFile('server.js'), 'utf8');
const lift = (start, end) => {
  const a = src.indexOf(start);
  const b = src.indexOf(end, a);
  if (a === -1 || b === -1) throw new Error(`could not lift ${start} out of server.js`);
  return src.slice(a, b);
};
const lifted = [
  lift('const normDigits =', '\n'),
  lift('const WORD_VALUES =', '\nfunction amountsInWords'),
  lift('function amountsInWords(text) {', '\n}\n') + '\n}',
  lift('function amountCandidates(text) {', '\n}\n') + '\n}',
  lift('function amountAppears(candidates, expectedAmount) {', '\n}\n') + '\n}',
].join('\n');
const { amountCandidates, amountAppears, amountsInWords } = new Function(
  `${lifted}; return { amountCandidates, amountAppears, amountsInWords };`)();

// The production classification, in one place: match / mismatch / unreadable.
const classify = (text, expected) => {
  const c = amountCandidates(text)
    .concat(amountsInWords(text).map((n) => ({ int: String(n), confident: true })));
  if (amountAppears(c, expected)) return 'match';
  return c.some((x) => x.confident) ? 'mismatch' : 'unreadable';
};

// A dark-mode UPI receipt, as the default pass reads it: everything except
// the amount, which is the one thing wanted.
const DARK_MODE_PASS1 = `3449 ul LTE EB
< po
To NQoCN
NQOCN20260001_A Delegate
© Completed
17 Aug 2026, 3:43pm
(— .
=. Some Bank of India 0913  v
UPI transaction ID
659575839049
To: NQoCN
conference@examplebank
From: A DELEGATE (Some Bank)
Google Pay + adelegate-1@okaxis`;

// The same slip on the second pass, which does read it.
const DARK_MODE_PASS2 = `750\n20260001\n0913\n659575839049`;

(async () => {
  console.log('\n== The shapes a real slip puts the amount in ==');
  const reads = (text, amt) => amountAppears(amountCandidates(text), amt);
  check('a plain number', reads('Paid\n₹3000\nCompleted', 3000));
  check('comma-grouped', reads('Paid\n₹3,000\nCompleted', 3000));
  check('with decimals', reads('Amount: Rs 3,000.00', 3000));
  check('INR prefix', reads('INR 750 paid', 750));
  check('zeroes read as the letter O', reads('₹3,OOO', 3000));
  check('ones read as l', reads('₹l250', 1250));
  check('the rupee glyph fused on as a stray digit', reads('2750\nTo NQoCN', 750));
  check('a decimal point lost from .00', reads('75000\nCompleted', 750));
  check('spaced thousands', reads('₹3 000', 3000));

  console.log('\n== What it must NOT accept ==');
  // The old matcher concatenated digit runs across the whole text, so three
  // unrelated numbers could be assembled into the fee.
  check('a number assembled across lines', !reads('3\nCompleted\n000\nBank', 3000));
  // ...and allowed a spurious character to be deleted from ANY position,
  // which let a smaller number satisfy a larger one.
  check('850 does not satisfy 8500', !reads('₹850 paid', 8500));
  check('a transaction reference that contains the amount', !reads('UPI transaction ID\n659582473750', 750));
  // An account tail IS a readable number, so it can satisfy a fee that
  // happens to equal it; what matters is that it is never CONFIDENT enough to
  // be reported as a wrong amount. That is asserted below.
  check('a year is not an amount', !amountCandidates('19 Aug 2026, 2:30 pm').some((c) => c.confident));

  console.log('\n== Confidence: what may be reported as a WRONG amount ==');
  const conf = (text) => amountCandidates(text).filter((c) => c.confident).map((c) => c.int);
  check('a number beside a rupee marker is confident', conf('₹750').includes('750'), conf('₹750'));
  check('a number alone at the top is confident', conf('To NQoCN\n750\nCompleted').includes('750'), conf('To NQoCN\n750\nCompleted'));
  // These are the ones that produced false crosses: a four-digit account tail
  // and a status-bar clock both look like fees.
  check('an account tail beside a bank name is not', !conf('x\nx\nx\nx\nx\nBank of Baroda 3183\nUPI transaction ID').includes('3183'),
    conf('x\nx\nx\nx\nx\nBank of Baroda 3183\nUPI transaction ID'));
  check('a bare number low down the slip is not',
    !conf('a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n9650\nk').includes('9650'), conf('a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n9650\nk'));

  console.log('\n== The three-state result ==');
  check('a correct amount reads as match', classify('To NQoCN\n₹750\nCompleted', 750) === 'match');
  check('a different amount beside a marker reads as mismatch', classify('To NQoCN\n₹500\nCompleted', 750) === 'mismatch');
  check('a dark-mode slip with nothing legible reads as unreadable',
    classify(DARK_MODE_PASS1, 750) === 'unreadable', classify(DARK_MODE_PASS1, 750));
  check('...and NOT as a mismatch, which is the whole point',
    classify(DARK_MODE_PASS1, 750) !== 'mismatch');
  check('the second pass rescues it', classify(DARK_MODE_PASS2, 750) === 'match', classify(DARK_MODE_PASS2, 750));

  console.log('\n== Amounts written out in words ==');
  // Bank and Paytm receipts print the amount in words under the figure, and
  // it survives OCR far better than the stylised digits: one approved slip
  // reads a perfectly clear "₹3,000" as "5000", and only the words save it.
  const w = (t) => amountsInWords(t);
  check('"Three Thousand Rupees"', w('Three Thousand Rupees').includes(3000), w('Three Thousand Rupees'));
  check('"Rupees Seven Hundred Fifty Only"', w('Rupees Seven Hundred Fifty Only').includes(750), w('Rupees Seven Hundred Fifty Only'));
  check('"Rupees One Thousand Five Hundred Only"', w('Rupees One Thousand Five Hundred Only').includes(1500), w('Rupees One Thousand Five Hundred Only'));
  check('lakhs, as Indian receipts write them', w('Two Lakh Fifty Thousand').includes(250000), w('Two Lakh Fifty Thousand'));
  check('two separate amounts stay separate', w('Three Thousand Rupees paid to Seven Hundred Fifty Ltd').length === 2,
    w('Three Thousand Rupees paid to Seven Hundred Fifty Ltd'));
  check('prose is not an amount', w('Completed and verified by the bank').length === 0, w('Completed and verified by the bank'));
  check('words rescue a misread figure',
    classify('Nqocn Conf 2026\n5000\nThree Thousand Rupees\nPaid Successfully', 3000) === 'match',
    classify('Nqocn Conf 2026\n5000\nThree Thousand Rupees\nPaid Successfully', 3000));
  check('and still contradict a genuinely wrong one',
    classify('Nqocn Conf 2026\n₹5000\nFive Thousand Rupees\nPaid Successfully', 3000) === 'mismatch');

  console.log('\n== Wiring ==');
  check('a second OCR pass is configured', /OCR_AMOUNT_PARAMS = \{[^}]*tessedit_pageseg_mode: '11'/.test(src));
  check('it uses Sauvola thresholding', /OCR_AMOUNT_PARAMS = \{[^}]*thresholding_method: '2'/.test(src));
  check('it only runs when the first pass found nothing', /if \(!found\) \{\s*\n\s*try \{\s*\n\s*const retry = await recognizeText\(buffer, OCR_AMOUNT_PARAMS\)/.test(src));
  check('the worker parameters are always restored', /finally \{[\s\S]{0,300}setParameters\(OCR_DEFAULT_PARAMS\)/.test(src));
  check('the status is persisted', /ocr_amount_status/.test(src));
  check('words are folded into the evidence', /amountsInWords\(text\)\.map/.test(src));
  check('an unreadable amount does not flag the registration',
    (src.match(/allChecksPass = checks\.amountStatus !== AMOUNT_MISMATCH/g) || []).length === 3,
    (src.match(/allChecksPass = checks\.amountStatus !== AMOUNT_MISMATCH/g) || []).length);
  const client = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
  check('the review modal shows the third state', /function reviewAmountMark/.test(client));
  check('and reads the new column', /reviewAmountMark\(p\.ocr_amount_status/.test(client));

  report();
})();
