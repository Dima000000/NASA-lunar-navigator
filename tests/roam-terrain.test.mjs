import test from "node:test";
import assert from "node:assert/strict";
import { nextWindow, ROAM } from "../app/roam-terrain.mjs";
import { navigationGeometry } from "../app/drive-navigation.mjs";

const half = 8,
  node = 16 / 30,
  base = { half, node, at: { nx: 0, ny: 0 } };

test("no new terrain window while the rover has room in the loaded one", () => {
  assert.equal(nextWindow({ ...base, rover: { x: 0, y: 0 } }), null);
  assert.equal(nextWindow({ ...base, rover: { x: 3.4, y: -3.4 } }), null);
});

test("near a border the next window is centred on the rover, on the horizon-atlas lattice", () => {
  const w = nextWindow({ ...base, rover: { x: 3.9, y: -0.7 } });
  assert.deepEqual([w.nx, w.ny, w.dx, w.dy], [7, -1, 7, -1]);
  // the rover ends up with (almost) the whole half-window of room again
  const room =
    half - Math.max(Math.abs(3.9 - w.dx * node), Math.abs(-0.7 - w.dy * node));
  assert(room > half - node);
  // offsets accumulate from the window the rover is leaving
  const next = nextWindow({ ...base, at: { nx: 7, ny: -1 }, rover: { x: -4.3, y: 0 } });
  assert.deepEqual([next.nx, next.ny], [-1, -1]);
});

test("at speed the window leads the rover but always leaves it more room than the trigger", () => {
  const w = nextWindow({ ...base, rover: { x: 3.6, y: 0 }, lead: { x: 40, y: 0 } });
  assert(w.dx * node > 3.6);
  assert(half - Math.abs(3.6 - w.dx * node) >= ROAM.triggerKm);
});

test("an active destination stays inside the next window while the rover still has room", () => {
  // rover drives east, destination 7 km behind it to the west
  const keep = nextWindow({
    ...base,
    rover: { x: 3.6, y: 0 },
    target: { x: -3.4, y: 0 },
  });
  assert.equal(keep.keepsTarget, true);
  assert(Math.abs(-3.4 - keep.dx * node) < half);
  // too far apart to hold both: the rover wins, the destination is released
  const drop = nextWindow({
    ...base,
    rover: { x: 7, y: 0 },
    target: { x: -7.5, y: 0 },
  });
  assert.equal(drop.keepsTarget, false);
  assert(half - Math.abs(7 - drop.dx * node) > half - node);
});

test("roaming stops at the limit of the place-centred grid", () => {
  const at = { nx: Math.floor(ROAM.limitKm / node), ny: 0 };
  assert.deepEqual(nextWindow({ ...base, at, rover: { x: 4, y: 0 } }), { limit: true });
  // moving back towards the place is always possible
  const back = nextWindow({ ...base, at, rover: { x: -4, y: 0 } });
  assert(back.nx < at.nx);
});

test("route geometry of a roaming window is offset from the place pin", () => {
  const site = { lat: -89.4399, lon: -137.1476 },
    h = new Float32Array(9),
    slope = new Float32Array(9),
    q = (ox, oy) => ({
      site,
      origin: { i: 1, j: 1 },
      target: { i: 2, j: 2 },
      dem: { N: 3, L: 2, cell: 1, h, slope, centerHeightM: 0, ox, oy },
    }),
    pin = navigationGeometry(q(0, 0)).coordinates(1, 1),
    moved = navigationGeometry(q(3, 0)).coordinates(1, 1),
    same = navigationGeometry(q(3, 0)).coordinates(-2, 1);
  assert(Math.abs(pin.lat - site.lat) < 1e-9);
  // 3 km east of the pin: about 0.1° of arc away, and the node 3 cells west of that centre is the pin again
  const R = 1737.4,
    rad = Math.PI / 180,
    arc =
      Math.acos(
        Math.sin(pin.lat * rad) * Math.sin(moved.lat * rad) +
          Math.cos(pin.lat * rad) * Math.cos(moved.lat * rad) * Math.cos((pin.lon - moved.lon) * rad),
      ) * R;
  assert(Math.abs(arc - 3) < 0.001);
  assert(Math.abs(same.lat - pin.lat) < 1e-9);
});
