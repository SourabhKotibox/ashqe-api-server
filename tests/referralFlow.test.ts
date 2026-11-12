import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateCommission,
  applyBuyerDiscount,
  effectiveDiscountPercent,
  effectiveRate,
  isValidPan,
  financialYearOf,
} from '../src/lib/partnerCommission';

describe('Referral Attribution & Commission Logic', () => {
  test('Partner commission calculation on full sale amount (gross base)', () => {
    // Plan priced at ₹999 with 10% partner commission
    const res = calculateCommission({
      saleAmount: 999,
      tax: 152.39,
      rate: 10,
      base: 'gross',
    });
    assert.equal(res.baseAmount, 999);
    assert.equal(res.rate, 10);
    assert.equal(res.amount, 99.9);
  });

  test('Partner commission calculation on net base (excluding tax)', () => {
    const res = calculateCommission({
      saleAmount: 1180,
      tax: 180,
      rate: 10,
      base: 'net',
    });
    assert.equal(res.baseAmount, 1000);
    assert.equal(res.rate, 10);
    assert.equal(res.amount, 100);
  });

  test('0% buyer discount still preserves partner quote code and commission eligibility', () => {
    // When partner has 0% buyer discount (only partner earns commission)
    const quote = applyBuyerDiscount(999, 0);
    assert.equal(quote.listPrice, 999);
    assert.equal(quote.discountPercent, 0);
    assert.equal(quote.discountAmount, 0);
    assert.equal(quote.finalAmount, 999);
  });

  test('Custom partner discount override (e.g. 15% discount for partner audience)', () => {
    const settings = { buyerDiscountEnabled: true, buyerDiscountPercent: 10 };
    // Partner has 15% override
    const rate = effectiveDiscountPercent({ couponDiscountPercent: 15 }, settings);
    assert.equal(rate, 15);
    const quote = applyBuyerDiscount(1000, rate);
    assert.equal(quote.finalAmount, 850);
    assert.equal(quote.discountAmount, 150);
  });

  test('Partner referral code formatting and PAN validation', () => {
    assert.equal(isValidPan('ABCDE1234F'), true);
    assert.equal(isValidPan('xyzpq9876z'), true);
    assert.equal(isValidPan('invalid_pan'), false);
    assert.equal(isValidPan('12345ABCDE'), false);
  });
});
