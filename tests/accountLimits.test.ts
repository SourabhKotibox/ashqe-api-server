import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  allowedDeviceIds,
  canCreateProfile,
  deviceIdentityForLogin,
  deviceLimitMessage,
  isDeviceAllowedToStream,
  pickCurrentSubscription,
  profileLimitMessage,
  publicLimitCount,
  registerDevice,
  resolveLimitCounts,
  serializeDevice,
  tierFromPlan,
  type DeviceRecord,
} from '../src/lib/accountLimits';

const at = (iso: string) => new Date(iso);

describe('plan tiers and limits', () => {
  test('named tiers win over a mismatched plan level', () => {
    assert.equal(tierFromPlan('Standard', 1), 'standard');
    assert.equal(tierFromPlan('Premium Yearly', 1), 'premium');
    assert.equal(tierFromPlan('Basic', 3), 'basic');
  });

  test('unknown paid names use the plan level', () => {
    assert.equal(tierFromPlan('Gold', 3), 'premium');
    assert.equal(tierFromPlan('Gold', 1), 'basic');
    assert.equal(tierFromPlan('Gold', 2), 'standard');
    assert.equal(tierFromPlan('Gold'), 'standard');
  });

  test('free and missing plans use one device and one profile', () => {
    assert.equal(tierFromPlan(null), 'free');
    assert.equal(tierFromPlan(''), 'free');
    assert.deepEqual(resolveLimitCounts('free', null), {
      deviceLimitCount: 1,
      profileLimitCount: 1,
    });
  });

  test('a PlanLimit row supplies the counts from seed data', () => {
    assert.deepEqual(
      resolveLimitCounts('standard', { deviceLimitCount: 2, profileLimitCount: 2 }),
      { deviceLimitCount: 2, profileLimitCount: 2 }
    );
    assert.deepEqual(
      resolveLimitCounts('premium', { deviceLimitCount: 4, profileLimitCount: 4 }),
      { deviceLimitCount: 4, profileLimitCount: 4 }
    );
  });

  test('a missing or zero count falls back to the tier', () => {
    assert.deepEqual(resolveLimitCounts('basic', { deviceLimitCount: 0, profileLimitCount: null }), {
      deviceLimitCount: 1,
      profileLimitCount: 1,
    });
  });
});

describe('active subscription selection', () => {
  test('the newest purchase wins over an older plan that ends later', () => {
    const older = {
      status: 'active',
      plan: 'Basic',
      createdAt: at('2026-01-01'),
      startDate: at('2026-01-01'),
      endDate: at('2027-01-01'),
    };
    const newer = {
      status: 'active',
      plan: 'Premium',
      createdAt: at('2026-06-01'),
      startDate: at('2026-06-01'),
      endDate: at('2026-07-01'),
    };
    assert.equal(pickCurrentSubscription([older, newer], at('2026-06-15'))?.plan, 'Premium');
  });

  test('expired rows are ignored and a missing end date stays active', () => {
    const expired = {
      status: 'active',
      plan: 'Premium',
      createdAt: at('2026-08-01'),
      endDate: at('2026-08-02'),
    };
    const open = {
      status: 'active',
      plan: 'Standard',
      createdAt: at('2026-01-01'),
      endDate: null,
    };
    assert.equal(pickCurrentSubscription([expired, open], at('2026-09-01'))?.plan, 'Standard');
  });

  test('inactive rows are ignored', () => {
    const inactive = {
      status: 'inactive',
      plan: 'Premium',
      createdAt: at('2026-08-01'),
      endDate: at('2027-01-01'),
    };
    assert.equal(pickCurrentSubscription([inactive], at('2026-09-01')), null);
  });
});

describe('device registration', () => {
  const phone = (id: string, seen: string): DeviceRecord => ({
    deviceId: id,
    deviceName: id,
    deviceType: 'mobile',
    lastActive: at(seen),
    lastSeen: at(seen),
  });

  test('a new device is added while the account is under the cap', () => {
    const result = registerDevice([phone('a', '2026-01-01')], {
      deviceId: 'b',
      deviceName: 'Second',
      deviceType: 'mobile',
    }, 2, at('2026-02-01'));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.devices.length, 2);
      assert.equal(result.overLimit, false);
    }
  });

  test('a new device at the cap is rejected and nothing is removed', () => {
    const result = registerDevice(
      [phone('a', '2026-01-01'), phone('b', '2026-01-02')],
      { deviceId: 'c', deviceName: 'Third', deviceType: 'web' },
      2
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'DEVICE_LIMIT_REACHED');
      assert.equal(result.deviceLimitCount, 2);
      assert.match(result.message, /allows 2 devices/);
      assert.match(result.message, /Manage Devices/);
      assert.equal(deviceLimitMessage(2), result.message);
    }
  });

  test('signing in on an existing allowed device refreshes lastActive', () => {
    const result = registerDevice(
      [phone('a', '2026-01-01')],
      { deviceId: 'a', deviceName: 'Phone', deviceType: 'mobile' },
      1,
      at('2026-03-01')
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.devices.length, 1);
      assert.equal(new Date(result.devices[0].lastActive as Date).toISOString(), at('2026-03-01').toISOString());
    }
  });

  test('an existing device outside the cap can sign in but is not promoted', () => {
    const devices = [phone('new', '2026-03-01'), phone('old', '2026-01-01')];
    const result = registerDevice(
      devices,
      { deviceId: 'old', deviceName: 'Old phone', deviceType: 'mobile' },
      1,
      at('2026-04-01')
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.overLimit, true);
      const old = result.devices.find((device) => device.deviceId === 'old');
      assert.equal(new Date(old?.lastActive as Date).toISOString(), at('2026-01-01').toISOString());
    }
  });

  test('streaming follows the most recently active devices inside the cap', () => {
    const devices = [phone('new', '2026-03-01'), phone('old', '2026-01-01')];
    assert.equal(isDeviceAllowedToStream(devices, 'new', 1), true);
    assert.equal(isDeviceAllowedToStream(devices, 'old', 1), false);
    assert.equal(isDeviceAllowedToStream(devices, 'removed', 1), false);
    assert.equal(isDeviceAllowedToStream(devices, 'unknown', 1), true);
    assert.equal(isDeviceAllowedToStream(devices, null, 1), true);
    assert.deepEqual([...allowedDeviceIds(devices, 1)], ['new']);
  });

  test('a login without a device id shares one web slot', () => {
    const identity = deviceIdentityForLogin('user-1', null);
    assert.equal(identity.deviceId, 'web:user-1');
    assert.equal(identity.deviceType, 'web');
    const again = deviceIdentityForLogin('user-1', { deviceId: '  ', deviceName: '', deviceType: '' });
    assert.equal(again.deviceId, 'web:user-1');
  });

  test('serialized devices keep lastSeen and expose lastActive for the app', () => {
    const serialized = serializeDevice({
      _id: 'abc',
      deviceId: 'phone-1',
      deviceName: 'Pixel',
      deviceType: 'mobile',
      lastSeen: at('2026-01-02'),
    });
    assert.equal(serialized.deviceId, 'phone-1');
    assert.equal(serialized.deviceName, 'Pixel');
    assert.equal(serialized.lastSeen, serialized.lastActive);
    assert.equal(serialized._id, 'abc');
  });
});

describe('profile cap', () => {
  test('creation stops once the plan count is reached', () => {
    assert.equal(canCreateProfile(1, 2), true);
    assert.equal(canCreateProfile(2, 2), false);
    assert.equal(canCreateProfile(0, 1), true);
    assert.equal(canCreateProfile(1, 1), false);
    assert.equal(profileLimitMessage(2), 'Profile limit of 2 reached on your current plan.');
    assert.equal(publicLimitCount(Number.POSITIVE_INFINITY), 100);
  });
});
