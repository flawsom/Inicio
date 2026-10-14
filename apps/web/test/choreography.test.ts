import { describe, expect, it } from 'vitest';
import {
  BEAT_COUNT,
  BEAT_IDS,
  HOLD,
  STATIONS,
  beatIndexAt,
  beatLocalAt,
  cameraAt,
  conflictAt,
  invitationAt,
  presenceAt,
  programAt,
  rollAt,
  syncAt,
  tenantsAt,
  travelAt,
} from '../src/immersive/choreography';

/**
 * The flight's choreography, tested without a GPU.
 *
 * A scene needs a renderer; a camera path does not, and the claims worth holding about
 * this page are about the path: that the hero has no 3D object in it, that each beat
 * holds still while its text is on screen and moves on afterwards, that the fly-through
 * banks and levels out, and that the device which loses signal never loses an answer.
 * Those are numbers, so they are asserted here rather than hoped for in a browser.
 */

const samples = (steps = 200): number[] => Array.from({ length: steps + 1 }, (_, i) => i / steps);

describe('the journey', () => {
  it('has exactly the six beats, in the order the camera visits them', () => {
    expect(BEAT_IDS).toEqual(['program', 'sync', 'conflict', 'flythrough', 'tenants', 'invitation']);
    expect(BEAT_COUNT).toBe(6);
    expect(STATIONS.length).toBe(BEAT_COUNT);
  });

  it('maps progress onto beats that cover the whole journey without a gap', () => {
    const seen: number[] = [];
    for (const progress of samples()) {
      const index = beatIndexAt(progress);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(BEAT_COUNT);
      if (seen[seen.length - 1] !== index) seen.push(index);
      // Local progress is the position inside that beat, always a real fraction.
      const local = beatLocalAt(progress);
      expect(local).toBeGreaterThanOrEqual(0);
      expect(local).toBeLessThanOrEqual(1);
    }
    // Every beat was visited, exactly once, in order.
    expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('clamps rather than wrapping at either end', () => {
    expect(beatIndexAt(-3)).toBe(0);
    expect(beatIndexAt(0)).toBe(0);
    expect(beatIndexAt(1)).toBe(BEAT_COUNT - 1);
    expect(beatIndexAt(9)).toBe(BEAT_COUNT - 1);
    expect(beatLocalAt(-1)).toBe(0);
    expect(beatLocalAt(4)).toBe(1);
  });

  it('draws nothing at all behind the hero, and is fully present by the second beat', () => {
    // The hero is pure typography: the scene has to be invisible while it is on screen,
    // which is the whole reason the first paint is a sentence rather than a render.
    for (const progress of [0, 0.004, 0.01]) {
      expect(presenceAt(progress)).toBeLessThan(0.02);
    }
    expect(presenceAt(0.08)).toBeGreaterThan(0.95);
  });

  it('holds the camera still while the text is on screen, then travels', () => {
    // The hold is the readable part of a beat, and its absence is what makes a
    // scroll-driven page feel like a fairground ride.
    expect(travelAt(0)).toBe(0);
    expect(travelAt(HOLD)).toBe(0);
    expect(travelAt(HOLD + (1 - HOLD) / 2)).toBeGreaterThan(0.4);
    expect(travelAt(1)).toBe(1);

    for (let index = 0; index < BEAT_COUNT - 1; index += 1) {
      const start = index / BEAT_COUNT;
      // At the very start of a beat the camera is standing at that beat's station.
      const atStart = cameraAt(start + 0.0005);
      expect(atStart.z).toBeCloseTo(STATIONS[index]!.z, 1);
      // By the end of it, it has arrived at the next one.
      const atEnd = cameraAt((index + 1) / BEAT_COUNT - 0.0005);
      expect(atEnd.z).toBeCloseTo(STATIONS[index + 1]!.z, 1);
    }
  });

  it('moves the camera forward down the corridor and never backwards', () => {
    // The flight is one continuous move: the Z the camera stands at must never turn
    // around, whatever the reader does with the scroll wheel.
    let previous = cameraAt(0).z;
    for (const progress of samples(400)) {
      const z = cameraAt(progress).z;
      expect(z).toBeLessThanOrEqual(previous + 0.001);
      previous = z;
    }
    // And it ends at the invitation.
    expect(cameraAt(1).z).toBeCloseTo(STATIONS[STATIONS.length - 1]!.z, 1);
  });

  it('banks through the fly-through and is level again before the realms', () => {
    const flythrough = BEAT_IDS.indexOf('flythrough');
    const start = flythrough / BEAT_COUNT;
    const end = (flythrough + 1) / BEAT_COUNT;

    expect(rollAt(start + 0.001)).toBeCloseTo(0, 2);
    // The lean is deepest halfway through the travel out of the corridor, not halfway
    // through the beat: the beat opens with a hold, like every other one.
    const travelMiddle = (flythrough + HOLD + (1 - HOLD) / 2) / BEAT_COUNT;
    expect(Math.abs(rollAt(travelMiddle))).toBeGreaterThan(0.3);
    expect(rollAt(end - 0.001)).toBeCloseTo(0, 2);
    // No other beat banks: the lean belongs to the one beat that is only a camera move.
    for (const progress of [0.02, 0.2, 0.38, 0.68, 0.9]) {
      expect(rollAt(progress)).toBe(0);
    }
  });
});

describe('the questionnaire as a program', () => {
  it('stands the questions up before it wires them', () => {
    const early = programAt(0.1);
    const late = programAt(1);
    // A rule cannot join two questions before both of them exist.
    expect(early.assembled).toBeGreaterThan(0);
    expect(early.wired).toBe(0);
    expect(late.assembled).toBe(1);
    expect(late.wired).toBe(1);
  });
});

describe('the device that loses signal', () => {
  it('fills its own buffer while it is off the network and empties it when it returns', () => {
    expect(syncAt(0.05).phase).toBe('streaming');
    expect(syncAt(0.5).phase).toBe('offline');
    expect(syncAt(0.9).phase).toBe('reconnected');

    // Nothing held before the signal goes, then it fills while there is nowhere to send,
    // then it empties as the answers go.
    expect(syncAt(0.3).held).toBe(0);
    expect(syncAt(0.5).held).toBeGreaterThan(0.2);
    expect(syncAt(0.7).held).toBeGreaterThan(syncAt(0.5).held);
    expect(syncAt(0.86).held).toBeLessThan(syncAt(0.72).held);
    expect(syncAt(1).held).toBeCloseTo(0, 2);
  });

  it('hands over what it held in one burst, at the moment the signal returns', () => {
    expect(syncAt(0.6).burst).toBe(0);
    expect(syncAt(0.72).burst).toBeLessThan(0.05);
    expect(syncAt(0.8).burst).toBeGreaterThan(0.5);
    expect(syncAt(0.98).burst).toBeLessThan(0.1);
  });

  it('dims the link rather than killing it, and never loses an answer', () => {
    // The path degrades and recovers: a connection that is *gone* is a connection whose
    // answers have nowhere to go, which is not what the product does.
    expect(syncAt(0.05).link).toBe(1);
    expect(syncAt(0.5).link).toBeGreaterThan(0);
    expect(syncAt(0.5).link).toBeLessThan(0.4);
    expect(syncAt(0.95).link).toBeGreaterThan(0.9);

    // The claim this whole product is about: what has been collected and delivered only
    // ever goes up.
    let previous = -1;
    for (const progress of samples(300)) {
      const delivered = syncAt(progress).delivered;
      expect(delivered).toBeGreaterThanOrEqual(previous - 0.0001);
      previous = delivered;
    }
    expect(previous).toBeCloseTo(1, 2);
  });
});

describe('conflict retention', () => {
  it('never lets the two versions of an answer meet', () => {
    for (const progress of samples(300)) {
      const { gap } = conflictAt(progress);
      // A persistent gap: the server value and the device value orbit one centre and
      // never occupy the same place, because nothing is auto-resolved away.
      expect(gap).toBeGreaterThan(0.2);
      expect(gap).toBeLessThan(0.5);
    }
  });
});

describe('tenant isolation', () => {
  it('seals the membranes and keeps them sealed', () => {
    expect(tenantsAt(0).sealed).toBe(0);
    expect(tenantsAt(1).sealed).toBe(1);
    let previous = -1;
    for (const progress of samples(200)) {
      const { sealed } = tenantsAt(progress);
      expect(sealed).toBeGreaterThanOrEqual(previous - 0.0001);
      previous = sealed;
      // The membrane is a boundary rather than a decoration: it is always drawn.
      expect(tenantsAt(progress).membrane).toBeGreaterThan(0.2);
    }
  });
});

describe('the invitation', () => {
  it('opens a ring around the last beat and leaves it open', () => {
    expect(invitationAt(0).seal).toBe(0);
    expect(invitationAt(0.4).seal).toBeGreaterThan(0.5);
    expect(invitationAt(1).seal).toBe(1);
    // The ring widens after it appears rather than at the same time, so the beat has two
    // moments instead of one.
    expect(invitationAt(0.4).widen).toBe(0);
    expect(invitationAt(1).widen).toBe(1);
  });
});
