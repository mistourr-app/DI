import { GodPowerSystem, type GodPowerBalance } from './GodPowerSystem';

function makeBalance(): GodPowerBalance {
  return {
    lightningKillCount: 2,
    lightningRadius: 60,
    superRadius: 100,
    superChargeRequired: 10
  };
}

describe('GodPowerSystem', () => {
  it('заряд копится от убийств и включает супер-режим', () => {
    const gp = new GodPowerSystem(makeBalance());
    expect(gp.progress).toBe(0);
    expect(gp.arm()).toBe(false);

    expect(gp.registerKills(5)).toBe(false);
    expect(gp.registerKills(5)).toBe(true);
    expect(gp.isCharged).toBe(true);
    expect(gp.progress).toBe(1);

    expect(gp.arm()).toBe(true);
    expect(gp.isArmed).toBe(true);
    expect(gp.consume()).toBe(100);
    expect(gp.isCharged).toBe(false);
  });

  it('закрытый супер-заряд не копится и не активируется (ELEMENT_UNLOCKS)', () => {
    const gp = new GodPowerSystem(makeBalance());
    gp.setLocked(true);
    expect(gp.isLocked).toBe(true);

    expect(gp.registerKills(100)).toBe(false);
    expect(gp.progress).toBe(0);
    expect(gp.isCharged).toBe(false);
    expect(gp.arm()).toBe(false);
    expect(gp.isArmed).toBe(false);
  });

  it('закрытие сбрасывает уже накопленный заряд и режим', () => {
    const gp = new GodPowerSystem(makeBalance());
    gp.registerKills(10);
    gp.arm();
    expect(gp.isArmed).toBe(true);

    gp.setLocked(true);
    expect(gp.isArmed).toBe(false);
    expect(gp.progress).toBe(0);

    gp.setLocked(false);
    expect(gp.registerKills(10)).toBe(true);
    expect(gp.arm()).toBe(true);
  });
});