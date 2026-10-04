'use strict';
/**
 * Human-only approval gate; model arguments are never trusted as approval.
 * Port of Raven/confirmation.py
 */

const crypto = require('crypto');
const { askLine } = require('./prompt');

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

class HumanConfirmation {
  /** @param {{print?:Function}} [opts] */
  constructor(opts = {}) {
    // Resolve console.log lazily: the interactive UI swaps it at runtime.
    this.print = (opts && opts.print) || ((...args) => console.log(...args));
  }

  async require(action) {
    const challenge = `RAVEN-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    this.print(`\nApproval required: ${action}`);
    this.print(`Type exactly ${challenge} to continue, or press Enter to deny.`);
    const answer = await askLine('Confirmation:');
    return timingSafeEqualStr(answer, challenge);
  }
}

module.exports = { HumanConfirmation };
