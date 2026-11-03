'use strict';

// What she may do on your PC without asking: every action has a class, the class a floor no setting goes
// under, and the phone never approves anything for the person at the PC. "Allow for an hour" (Grant) skips
// the question for looking and clicking only; deleting, sending, paying, installing, passwords and anything
// with a warning of its own (`ask`) are asked every time.

const CLASSES = ['READ_ONLY', 'UI_CONTROL', 'FILE_WRITE', 'TERMINAL_EXEC', 'NETWORK_SEND', 'DELETE', 'CREDENTIAL_ACCESS'];

const ORDER = { allow: 0, confirm: 1, deny: 2 };
const FLOOR = {
  READ_ONLY: 'allow',
  UI_CONTROL: 'confirm', // her hands on your desktop: through the question, where the hour applies
  FILE_WRITE: 'allow',
  TERMINAL_EXEC: 'confirm',
  NETWORK_SEND: 'confirm',
  DELETE: 'confirm',
  CREDENTIAL_ACCESS: 'confirm',
};
const GRANTABLE = new Set(['READ_ONLY', 'UI_CONTROL']);
const GRANT_MS = 60 * 60 * 1000;

/** 'allow', 'confirm' or 'deny' for one action: the stricter of your choice and the class's floor. */
function decide(cls, { origin = 'pc', wanted = 'allow', ask } = {}) {
  if (!CLASSES.includes(cls)) return 'deny';
  if (origin === 'phone' && cls !== 'READ_ONLY') return 'deny'; // the phone can't say yes for the PC
  let policy = ORDER[wanted] >= ORDER[FLOOR[cls]] ? wanted : FLOOR[cls];
  if (ask && policy === 'allow') policy = 'confirm';
  return policy;
}

/** Can "Allow for an hour" cover it? Looking and clicking without a warning of its own, nothing else. */
const grantable = (cls, ask) => GRANTABLE.has(cls) && !ask;

// "Allow for an hour": your click, never extended by itself, gone when she restarts.
class Grant {
  constructor() { this.until = 0; }
  covers(cls, ask, now = Date.now()) { return grantable(cls, ask) && now < this.until; }
  grant(now = Date.now()) { this.until = now + GRANT_MS; }
  revoke() { this.until = 0; }
  minutesLeft(now = Date.now()) { return Math.max(0, Math.ceil((this.until - now) / 60000)); }
}

module.exports = { CLASSES, decide, grantable, Grant, GRANT_MS };
