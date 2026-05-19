import { useState, useEffect, useRef, useCallback, useMemo } from "react";

// ===== CONFIG =====
// Whole game renders at fixed 320x200 internal resolution (DOS-era 16:10),
// scaled up to fit the viewport. Room and pet popup live inside this 320x200 area.
const ROOM_W = 320;
const ROOM_H = 200;
const TILE_W = 28; // isometric tile width
const TILE_H = 14; // isometric tile height
const ROOM_TILES_X = 7;
const ROOM_TILES_Y = 7;
const ROOM_OFFSET_Y = 75; // room sits in the lower-middle of the canvas
const PIXEL_SCALE = 2;
const MOVE_SPEED = 0.55;
const PLAYER_SIZE = 12;
const CAT_SIZE = 14;
const INTERACT_DIST = 26;

const CAT_PERSONALITIES = [
  { type: "clingy",    color: "#F4A460", earColor: "#D4956A", eyeColor: "#5D4E37", threshold: 100, gainRate: 1.0,  warningInterval: 0    },
  { type: "normal",    color: "#9E9E9E", earColor: "#757575", eyeColor: "#3A3A3A", threshold: 120, gainRate: 0.7,  warningInterval: 8000 },
  { type: "tsundere",  color: "#F5F5F5", earColor: "#FFD1DC", eyeColor: "#6B8E9B", threshold: 140, gainRate: 0.5,  warningInterval: 5000 },
  { type: "explosive", color: "#3A3A3A", earColor: "#1a1a1a", eyeColor: "#C9A84C", threshold: 90,  gainRate: 1.3,  warningInterval: 3500 },
  { type: "sleepy",    color: "#D4956A", earColor: "#A67550", eyeColor: "#5B4636", threshold: 110, gainRate: 0.85, warningInterval: 9000 },
];

// Continuous-mode tuning
const WARNING_DURATION = 2000; // user has ~2 seconds to stop petting before cat jumps away
const MIN_CATS_IN_ROOM = 1;    // owner will drop off a new cat if count drops below this
const MAX_CATS_IN_ROOM = 4;    // owner stops dropping off when this many are present
const REST_DURATION_MIN = 25000; // satisfied cats wait at least this long before wanting pets again (ms)
const REST_DURATION_MAX = 60000; // ...and at most this long
const PICKUP_CHANCE_INTERVAL = 35000; // every ~35s a satisfied cat may be picked up
const DOOR_COOLDOWN_MS = 6000; // minimum time between door events so they don't overlap
const DOOR_EVENT_MS = 2200; // duration of a door-open animation (hand reaches in)
const CAT_WALK_SPEED = 0.7; // tiles per second when a cat wanders or walks to/from the door

// ===== ISOMETRIC HELPERS =====
// convert tile coords to screen pixel coords
const tileToScreen = (tx, ty) => {
  const x = (tx - ty) * (TILE_W / 2) + ROOM_W / 2;
  const y = (tx + ty) * (TILE_H / 2) + ROOM_OFFSET_Y;
  return { x, y };
};

// convert world (x,y in tile units) to screen
const worldToScreen = (wx, wy) => {
  const x = (wx - wy) * (TILE_W / 2) + ROOM_W / 2;
  const y = (wx + wy) * (TILE_H / 2) + ROOM_OFFSET_Y;
  return { x, y };
};

// ===== PIXEL ART RENDERING (canvas) =====

// draw the isometric room background to a canvas
const drawRoom = (ctx) => {
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, ROOM_W, ROOM_H);

  // background tint - fixed warm cream
  ctx.fillStyle = "rgb(250, 235, 220)";
  ctx.fillRect(0, 0, ROOM_W, ROOM_H);

  // floor tiles
  for (let ty = 0; ty < ROOM_TILES_Y; ty++) {
    for (let tx = 0; tx < ROOM_TILES_X; tx++) {
      const top = tileToScreen(tx, ty);
      const right = tileToScreen(tx + 1, ty);
      const bottom = tileToScreen(tx + 1, ty + 1);
      const left = tileToScreen(tx, ty + 1);

      // alternating wood plank colors
      const isLight = (tx + ty) % 2 === 0;
      ctx.fillStyle = isLight ? "rgb(204, 169, 134)" : "rgb(189, 154, 119)";

      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(right.x, right.y);
      ctx.lineTo(bottom.x, bottom.y);
      ctx.lineTo(left.x, left.y);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = "rgba(120, 90, 60, 0.15)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // back walls
  const wallTopColor = "rgb(239, 214, 199)";
  const wallSideColor = "rgb(214, 184, 169)";
  const wallH = 60;

  // left wall (at tx = 0)
  ctx.fillStyle = wallTopColor;
  ctx.beginPath();
  const lw1 = tileToScreen(0, 0);
  const lw2 = tileToScreen(0, ROOM_TILES_Y);
  ctx.moveTo(lw1.x, lw1.y);
  ctx.lineTo(lw1.x, lw1.y - wallH);
  ctx.lineTo(lw2.x, lw2.y - wallH);
  ctx.lineTo(lw2.x, lw2.y);
  ctx.closePath();
  ctx.fill();

  // right wall (at ty = 0)
  ctx.fillStyle = wallSideColor;
  ctx.beginPath();
  const rw1 = tileToScreen(0, 0);
  const rw2 = tileToScreen(ROOM_TILES_X, 0);
  ctx.moveTo(rw1.x, rw1.y);
  ctx.lineTo(rw1.x, rw1.y - wallH);
  ctx.lineTo(rw2.x, rw2.y - wallH);
  ctx.lineTo(rw2.x, rw2.y);
  ctx.closePath();
  ctx.fill();

  // window on left wall
  const winY = lw1.y - 44;
  const winX1 = (lw1.x + lw2.x) / 2 - 22;
  ctx.fillStyle = "#8D6E63";
  ctx.fillRect(winX1 - 1, winY - 1, 24, 18);
  ctx.fillStyle = "rgb(200, 215, 210)";
  ctx.fillRect(winX1, winY, 22, 16);
  ctx.fillStyle = "#8D6E63";
  ctx.fillRect(winX1 + 10, winY, 2, 16);
  ctx.fillRect(winX1, winY + 7, 22, 2);

  // door on right wall (entrance for cats and owners)
  // positioned near the corner of the right wall at the back
  const doorAnchor = tileToScreen(ROOM_TILES_X * 0.85, 0);
  ctx.fillStyle = "#5D4037";
  ctx.fillRect(doorAnchor.x - 7, doorAnchor.y - 40, 14, 40);
  ctx.fillStyle = "#8B5A3C";
  ctx.fillRect(doorAnchor.x - 6, doorAnchor.y - 38, 12, 38);
  // doorknob
  ctx.fillStyle = "#FFD54F";
  ctx.fillRect(doorAnchor.x + 3, doorAnchor.y - 20, 1, 2);

  // painting on right wall (moved slightly to make room for door)
  const pW = tileToScreen(ROOM_TILES_X * 0.35, 0);
  ctx.fillStyle = "#5D4037";
  ctx.fillRect(pW.x - 8, pW.y - 46, 16, 12);
  ctx.fillStyle = "#FFE0B2";
  ctx.fillRect(pW.x - 7, pW.y - 45, 14, 10);
  ctx.fillStyle = "#5D4037";
  ctx.fillRect(pW.x - 3, pW.y - 41, 6, 4);
  ctx.fillRect(pW.x - 3, pW.y - 42, 1, 1);
  ctx.fillRect(pW.x + 2, pW.y - 42, 1, 1);
};

// draw a furniture sprite at a tile position (occupies 1+ tiles)
const drawFurniture = (ctx, item) => {
  const screen = worldToScreen(item.tx, item.ty);
  const x = screen.x;
  const y = screen.y;

  if (item.type === "rug") {
    // a colored rug spanning 2x2 tiles
    ctx.fillStyle = "rgba(232, 150, 125, 0.45)";
    const a = worldToScreen(item.tx, item.ty);
    const b = worldToScreen(item.tx + item.w, item.ty);
    const c = worldToScreen(item.tx + item.w, item.ty + item.h);
    const d = worldToScreen(item.tx, item.ty + item.h);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y);
    ctx.closePath();
    ctx.fill();
  } else if (item.type === "catBed") {
    ctx.fillStyle = "#F8BBD0";
    ctx.beginPath();
    ctx.ellipse(x, y, 13, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#F48FB1";
    ctx.beginPath();
    ctx.ellipse(x, y - 1, 9, 4, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (item.type === "scratchPost") {
    ctx.fillStyle = "#8D6E63";
    ctx.fillRect(x - 3, y - 24, 6, 24);
    ctx.fillStyle = "#A1887F";
    ctx.fillRect(x - 5, y - 3, 10, 3);
    ctx.fillStyle = "#6D4C41";
    ctx.fillRect(x - 7, y - 28, 14, 4);
  } else if (item.type === "shelf") {
    ctx.fillStyle = "#6D4C41";
    ctx.fillRect(x - 12, y - 19, 24, 3);
    ctx.fillRect(x - 12, y - 10, 24, 3);
    const bookColors = ["#E57373", "#81C784", "#64B5F6", "#FFB74D", "#BA68C8"];
    bookColors.forEach((bc, i) => {
      ctx.fillStyle = bc;
      ctx.fillRect(x - 11 + i * 5, y - 26, 4, 7);
    });
  } else if (item.type === "plant") {
    ctx.fillStyle = "#A1887F";
    ctx.fillRect(x - 4, y - 7, 9, 7);
    ctx.fillStyle = "#66BB6A";
    ctx.beginPath();
    ctx.ellipse(x, y - 12, 7, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#81C784";
    ctx.fillRect(x - 5, y - 15, 3, 3);
    ctx.fillRect(x + 2, y - 14, 3, 4);
  } else if (item.type === "table") {
    ctx.fillStyle = "#A1887F";
    ctx.beginPath();
    ctx.ellipse(x, y - 9, 11, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#8D6E63";
    ctx.fillRect(x - 1, y - 7, 2, 7);
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(x - 3, y - 13, 4, 4);
    ctx.fillStyle = "#8D6E63";
    ctx.fillRect(x - 3, y - 13, 4, 1);
  } else if (item.type === "foodBowl") {
    ctx.fillStyle = "#5D4037";
    ctx.beginPath();
    ctx.ellipse(x, y, 6, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#FFAB91";
    ctx.beginPath();
    ctx.ellipse(x, y - 1, 4, 2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
};

// pixel cat sprite (top view-ish)
const drawCat = (ctx, x, y, color, earColor, eyeColor) => {
  ctx.imageSmoothingEnabled = false;

  // shadow
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.beginPath();
  ctx.ellipse(x, y + 4, 9, 3, 0, 0, Math.PI * 2);
  ctx.fill();

  // body
  ctx.fillStyle = color;
  ctx.fillRect(x - 6, y - 4, 12, 8);
  // head
  ctx.fillRect(x - 5, y - 9, 10, 6);
  // ears
  ctx.fillStyle = color;
  ctx.fillRect(x - 5, y - 11, 3, 3);
  ctx.fillRect(x + 2, y - 11, 3, 3);
  ctx.fillStyle = earColor;
  ctx.fillRect(x - 4, y - 10, 1, 1);
  ctx.fillRect(x + 3, y - 10, 1, 1);
  // eyes
  ctx.fillStyle = eyeColor;
  ctx.fillRect(x - 3, y - 7, 1, 1);
  ctx.fillRect(x + 2, y - 7, 1, 1);
  // tail
  ctx.fillStyle = color;
  ctx.fillRect(x + 6, y - 2, 2, 4);
  ctx.fillRect(x + 8, y - 4, 2, 3);
};

// Draws a small icon above a cat (heart, sleep z, scratch mark, or "wants pets" bubble)
const drawCatIcon = (ctx, x, y, kind, time) => {
  ctx.imageSmoothingEnabled = false;
  const iconY = y - 18;
  if (kind === "happy") {
    // pink heart, slight bob
    const bob = Math.sin(time / 200) * 1;
    ctx.fillStyle = "#E91E63";
    ctx.font = "bold 11px monospace";
    ctx.textAlign = "center";
    ctx.fillText("♥", x, iconY + bob);
  } else if (kind === "fled") {
    ctx.fillStyle = "#999";
    ctx.font = "9px monospace";
    ctx.textAlign = "center";
    ctx.fillText("· · ·", x, iconY);
  } else if (kind === "scratched") {
    ctx.fillStyle = "#D32F2F";
    ctx.font = "bold 11px monospace";
    ctx.textAlign = "center";
    ctx.fillText("✕", x, iconY);
  } else if (kind === "wants") {
    // thought bubble with paw print, gentle bob
    const bob = Math.sin(time / 400) * 1;
    const bx = x;
    const by = iconY + bob - 2;
    // bubble background
    ctx.fillStyle = "#FFFFFF";
    ctx.beginPath();
    ctx.ellipse(bx, by, 7, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#5D4037";
    ctx.lineWidth = 1;
    ctx.stroke();
    // little tail of bubble
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(bx - 2, by + 5, 2, 2);
    ctx.strokeRect(bx - 2, by + 5, 2, 2);
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(bx - 3, by + 7, 1, 1);
    // paw print inside (4 toe pads + main pad)
    ctx.fillStyle = "#E87272";
    // main pad
    ctx.fillRect(bx - 1, by, 3, 3);
    // toe pads
    ctx.fillRect(bx - 3, by - 2, 1, 1);
    ctx.fillRect(bx - 1, by - 3, 1, 1);
    ctx.fillRect(bx + 1, by - 3, 1, 1);
    ctx.fillRect(bx + 3, by - 2, 1, 1);
  } else if (kind === "petted") {
    // sleep z floating up
    const t = (time / 80) % 30;
    ctx.fillStyle = "#A1887F";
    ctx.font = "8px monospace";
    ctx.textAlign = "center";
    ctx.globalAlpha = Math.max(0, 1 - t / 30);
    ctx.fillText("z", x + 2, iconY - t / 2);
    ctx.globalAlpha = 1;
  }
};

// pixel player sprite
const drawPlayer = (ctx, x, y, facing) => {
  ctx.imageSmoothingEnabled = false;
  // shadow
  ctx.fillStyle = "rgba(0,0,0,0.2)";
  ctx.beginPath();
  ctx.ellipse(x, y + 6, 9, 3, 0, 0, Math.PI * 2);
  ctx.fill();

  // body (apron)
  ctx.fillStyle = "#D4805A";
  ctx.fillRect(x - 5, y - 5, 11, 11);
  // pocket
  ctx.fillStyle = "#A85A35";
  ctx.fillRect(x - 3, y, 6, 3);

  // head
  ctx.fillStyle = "#FFCCBC";
  ctx.fillRect(x - 4, y - 14, 9, 9);
  // hair
  ctx.fillStyle = "#3E2723";
  ctx.fillRect(x - 4, y - 15, 9, 3);
  ctx.fillRect(x - 5, y - 12, 1, 4);
  ctx.fillRect(x + 5, y - 12, 1, 4);

  // eyes
  ctx.fillStyle = "#3E2723";
  if (facing === "left") {
    ctx.fillRect(x - 3, y - 9, 1, 1);
    ctx.fillRect(x, y - 9, 1, 1);
  } else if (facing === "right") {
    ctx.fillRect(x - 1, y - 9, 1, 1);
    ctx.fillRect(x + 2, y - 9, 1, 1);
  } else {
    ctx.fillRect(x - 2, y - 9, 1, 1);
    ctx.fillRect(x + 1, y - 9, 1, 1);
  }
};

// Door hand animation - a hand emerges from the doorway briefly when the door opens.
// t is normalized time from 0 (door starts opening) to 1 (event complete).
// The hand reaches in (0..0.3), holds (0.3..0.7), retracts (0.7..1).
const drawDoorHand = (ctx, t) => {
  ctx.imageSmoothingEnabled = false;
  // Door position in screen coords (matches the door drawn in drawRoom)
  // The door on the back wall is anchored at tileToScreen(ROOM_TILES_X * 0.85, 0).
  const doorAnchor = (() => {
    const TX = ROOM_TILES_X * 0.85;
    return {
      x: (TX - 0) * (TILE_W / 2) + ROOM_W / 2,
      y: 0 + ROOM_OFFSET_Y,
    };
  })();

  // Hand emerges downward from the door (back wall). At t=0, hand is hidden inside the door.
  // At peak (t=0.5), hand is at the doorway floor. Then retracts.
  let extension;
  if (t < 0.3) extension = t / 0.3;
  else if (t < 0.7) extension = 1;
  else extension = (1 - t) / 0.3;
  extension = Math.max(0, Math.min(1, extension));

  // Arm/hand reaches from door down toward (slightly in front of) the doorway.
  const handStartY = doorAnchor.y - 30; // up inside the door frame
  const handEndY = doorAnchor.y + 2;    // just past the doorway onto the floor area
  const handY = handStartY + (handEndY - handStartY) * extension;
  const handX = doorAnchor.x - 1; // roughly center of door

  // dark "open door" rectangle to show the door is ajar
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(doorAnchor.x - 5, doorAnchor.y - 38, 10, 38);

  // Sleeve/arm (a dark vertical bar extending from inside the door down to the hand)
  ctx.fillStyle = "#3E2A1E";
  ctx.fillRect(handX - 2, handStartY, 4, handY - handStartY);
  // cuff highlight
  ctx.fillStyle = "#5D4037";
  ctx.fillRect(handX - 2, handY - 3, 4, 2);
  // hand (skin-colored pixel block)
  ctx.fillStyle = "#FFCCBC";
  ctx.fillRect(handX - 2, handY - 1, 4, 4);
  ctx.fillRect(handX - 3, handY, 1, 2);
  ctx.fillRect(handX + 2, handY, 1, 2);
};

// ====== PETTING VIEW (the popup) ======

const PettingCat = ({ mood, color, earColor, eyeColor, warning, scratched, tailWag }) => {
  let eyeShape, mouthPath, extraElements = null;
  let earLeft = "35,45 50,5 75,40";
  let earRight = "125,40 150,5 165,45";
  let earInnerLeft = "42,42 52,15 70,40";
  let earInnerRight = "130,40 148,15 158,42";

  if (warning) {
    earLeft = "25,48 55,12 75,42";
    earRight = "125,42 145,12 175,48";
    earInnerLeft = "32,46 57,18 70,42";
    earInnerRight = "130,42 143,18 168,46";
  }

  if (scratched) {
    eyeShape = (<>
      <line x1="55" y1="55" x2="70" y2="70" stroke={eyeColor} strokeWidth="3" strokeLinecap="round"/>
      <line x1="70" y1="55" x2="55" y2="70" stroke={eyeColor} strokeWidth="3" strokeLinecap="round"/>
      <line x1="130" y1="55" x2="145" y2="70" stroke={eyeColor} strokeWidth="3" strokeLinecap="round"/>
      <line x1="145" y1="55" x2="130" y2="70" stroke={eyeColor} strokeWidth="3" strokeLinecap="round"/>
    </>);
    mouthPath = <path d="M85 100 Q100 88 115 100" stroke="#E87272" strokeWidth="2.5" fill="none"/>;
  } else if (warning) {
    eyeShape = (<>
      <line x1="50" y1="56" x2="65" y2="62" stroke={eyeColor} strokeWidth="3" strokeLinecap="round"/>
      <circle cx="63" cy="66" r="5.5" fill={eyeColor}/><circle cx="64" cy="65" r="1.5" fill="white"/>
      <line x1="150" y1="56" x2="135" y2="62" stroke={eyeColor} strokeWidth="3" strokeLinecap="round"/>
      <circle cx="137" cy="66" r="5.5" fill={eyeColor}/><circle cx="136" cy="65" r="1.5" fill="white"/>
    </>);
    mouthPath = <path d="M88 100 Q100 91 112 100" stroke="#E87272" strokeWidth="2.5" fill="none"/>;
  } else if (mood === "happy") {
    eyeShape = (<>
      <path d="M55 65 Q62 55 70 65" stroke={eyeColor} strokeWidth="3" fill="none" strokeLinecap="round"/>
      <path d="M130 65 Q137 55 145 65" stroke={eyeColor} strokeWidth="3" fill="none" strokeLinecap="round"/>
    </>);
    mouthPath = <path d="M88 95 Q100 110 112 95" stroke="#E87272" strokeWidth="2" fill="none"/>;
    extraElements = (<>
      <circle cx="55" cy="80" r="8" fill="#FFB6C1" opacity="0.4"/>
      <circle cx="145" cy="80" r="8" fill="#FFB6C1" opacity="0.4"/>
    </>);
  } else if (mood === "annoyed") {
    eyeShape = (<>
      <line x1="52" y1="55" x2="62" y2="60" stroke={eyeColor} strokeWidth="2.5" strokeLinecap="round"/>
      <circle cx="62" cy="65" r="5" fill={eyeColor}/>
      <line x1="148" y1="55" x2="138" y2="60" stroke={eyeColor} strokeWidth="2.5" strokeLinecap="round"/>
      <circle cx="138" cy="65" r="5" fill={eyeColor}/>
    </>);
    mouthPath = <path d="M88 100 Q100 92 112 100" stroke="#E87272" strokeWidth="2" fill="none"/>;
  } else {
    eyeShape = (<>
      <circle cx="62" cy="62" r="7" fill={eyeColor}/><circle cx="138" cy="62" r="7" fill={eyeColor}/>
      <circle cx="64" cy="60" r="2.5" fill="white"/><circle cx="140" cy="60" r="2.5" fill="white"/>
    </>);
    mouthPath = <path d="M92 98 Q100 104 108 98" stroke="#E87272" strokeWidth="2" fill="none"/>;
  }

  const tailAngle = tailWag ? Math.sin(Date.now() / 80) * 20 : 0;

  return (
    <svg viewBox="0 0 220 180" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" style={{ shapeRendering: "crispEdges", maxHeight: "100%", display: "block" }}>
      <path d={`M168 140 Q${195+tailAngle*0.6} 115 ${190+tailAngle} 85`} stroke={color} strokeWidth="8" fill="none" strokeLinecap="round"/>
      <ellipse cx="100" cy="155" rx="75" ry="25" fill={color} opacity="0.6"/>
      <polygon points={earLeft} fill={color}/><polygon points={earRight} fill={color}/>
      <polygon points={earInnerLeft} fill={earColor} opacity="0.6"/><polygon points={earInnerRight} fill={earColor} opacity="0.6"/>
      <ellipse cx="100" cy="85" rx="68" ry="60" fill={color}/>
      {eyeShape}
      <ellipse cx="100" cy="88" rx="5" ry="3.5" fill="#E87272"/>
      {mouthPath}
      <line x1="10" y1="82" x2="45" y2="85" stroke="#BBB" strokeWidth="1.2"/>
      <line x1="10" y1="92" x2="45" y2="90" stroke="#BBB" strokeWidth="1.2"/>
      <line x1="155" y1="85" x2="190" y2="82" stroke="#BBB" strokeWidth="1.2"/>
      <line x1="155" y1="90" x2="190" y2="92" stroke="#BBB" strokeWidth="1.2"/>
      {extraElements}
      {warning && <text x="100" y="18" textAnchor="middle" fontSize="20" fill="#E87272" fontWeight="bold">⚠</text>}
    </svg>
  );
};

// ===== ROOM LAYOUT =====
// Furniture items in tile coordinates (collision blocked)
const FURNITURE = [
  // visual-only items
  { type: "rug", tx: 2, ty: 2, w: 3, h: 3, blocking: false },
  { type: "catBed", tx: 4.5, ty: 4.8, blocking: false },
  { type: "catBed", tx: 2.2, ty: 4.8, blocking: false },
  { type: "foodBowl", tx: 6, ty: 3.5, blocking: false },
  // blocking items - blockHalfX / blockHalfY are tile half-extents (more forgiving than before)
  { type: "shelf", tx: 1, ty: 0.4, blocking: true, blockHalfX: 0.55, blockHalfY: 0.4 },
  { type: "table", tx: 5.5, ty: 0.9, blocking: true, blockHalfX: 0.5, blockHalfY: 0.45 },
  { type: "scratchPost", tx: 0.6, ty: 3.5, blocking: true, blockHalfX: 0.4, blockHalfY: 0.4 },
  { type: "plant", tx: 6.4, ty: 5.8, blocking: true, blockHalfX: 0.4, blockHalfY: 0.4 },
  { type: "plant", tx: 0.5, ty: 6.4, blocking: true, blockHalfX: 0.4, blockHalfY: 0.4 },
];

// ===== AUDIO SYSTEM =====
// All audio files live at /audio/ (absolute path from site root).
// Files in public/ are copied to the build root by Vite, so they're served at /audio/*.
const AUDIO_BASE = "/audio";
const AUDIO_FILES = {
  bgm: `${AUDIO_BASE}/background_music.mp3`,
  purr: `${AUDIO_BASE}/cat_purr.mp3`,
  meow: `${AUDIO_BASE}/cat_meow.mp3`,
  hiss: `${AUDIO_BASE}/cat_hiss.mp3`,
  chime: `${AUDIO_BASE}/chime.mp3`,
  piano: `${AUDIO_BASE}/soft_piano.mp3`,
  click: `${AUDIO_BASE}/mouse_click.mp3`,
};

// Base volume for each clip (0..1). Multiplied by category volume at runtime.
const BASE_VOLUMES = {
  bgm: 0.5,
  purr: 1.0,
  meow: 0.9,
  hiss: 0.8,
  chime: 0.6,
  piano: 0.85,
  click: 0.6,
};

// Which category each clip belongs to. "music" or "sfx".
const AUDIO_CATEGORY = {
  bgm: "music",
  piano: "music",
  purr: "sfx",
  meow: "sfx",
  hiss: "sfx",
  chime: "sfx",
  click: "sfx",
};

// Hook that creates a preloaded audio bank with helpers.
function useAudioBank(musicVolume, sfxVolume) {
  const banksRef = useRef(null);
  const mutedRef = useRef(false);

  const needsBuild = !banksRef.current
    || Object.values(banksRef.current).length === 0
    || Object.values(banksRef.current).some(a => !a || !a.src);

  if (needsBuild) {
    const bank = {};
    if (typeof Audio !== "undefined") {
      Object.entries(AUDIO_FILES).forEach(([key, src]) => {
        try {
          const a = new Audio(src);
          const cat = AUDIO_CATEGORY[key];
          const catVol = cat === "music" ? musicVolume : sfxVolume;
          a.volume = (BASE_VOLUMES[key] ?? 0.5) * catVol;
          a.preload = "auto";
          if (key === "bgm" || key === "purr" || key === "piano") a.loop = true;
          bank[key] = a;
        } catch (e) {
          console.warn(`Failed to create audio for ${key}:`, e);
        }
      });
    } else {
      console.warn("[audio] window.Audio is undefined - cannot create audio bank");
    }
    banksRef.current = bank;
    console.log("[audio] bank built:", Object.keys(bank).length, "tracks, AUDIO_BASE=", AUDIO_BASE, "first src:", bank.bgm?.src);
  }

  // Update volumes whenever the sliders change
  useEffect(() => {
    if (!banksRef.current) return;
    Object.entries(banksRef.current).forEach(([key, a]) => {
      if (!a) return;
      const cat = AUDIO_CATEGORY[key];
      const catVol = cat === "music" ? musicVolume : sfxVolume;
      try { a.volume = (BASE_VOLUMES[key] ?? 0.5) * catVol; } catch (e) {}
    });
  }, [musicVolume, sfxVolume]);

  const play = useCallback((key, opts = {}) => {
    if (mutedRef.current) { console.log("[audio] play skipped (muted):", key); return; }
    const bank = banksRef.current;
    if (!bank) { console.warn("[audio] play called but bank is null:", key); return; }
    const a = bank[key];
    if (!a) { console.warn("[audio] play missing bank entry:", key); return; }
    try {
      if (opts.restart !== false && !a.loop) a.currentTime = 0;
      const p = a.play();
      if (p && p.catch) p.catch((err) => { console.warn("[audio] play rejected:", key, err.name); });
    } catch (e) { console.warn("[audio] play threw:", key, e); }
  }, []);

  const stop = useCallback((key) => {
    const bank = banksRef.current;
    if (!bank) return;
    const a = bank[key];
    if (!a) return;
    try { a.pause(); a.currentTime = 0; } catch (e) {/* ignore */}
  }, []);

  const pause = useCallback((key) => {
    const bank = banksRef.current;
    if (!bank) return;
    const a = bank[key];
    if (!a) return;
    try { a.pause(); } catch (e) {/* ignore */}
  }, []);

  const setMuted = useCallback((muted) => {
    mutedRef.current = muted;
    if (muted) {
      const bank = banksRef.current;
      if (bank) Object.values(bank).forEach(a => { try { a.pause(); } catch (e) {} });
    }
  }, []);

  // Get the underlying HTMLAudioElement for a key (for state inspection)
  const getElement = useCallback((key) => banksRef.current?.[key] || null, []);

  // cleanup on unmount: pause everything. Do NOT clear banksRef or set src="" — that would
  // break audio.play() on any subsequent invocation (StrictMode in dev re-mounts the
  // component, which would otherwise leave the bank pointing at null/empty audios).
  useEffect(() => {
    return () => {
      const cur = banksRef.current;
      if (cur) {
        Object.values(cur).forEach(a => {
          try { a.pause(); } catch (e) {}
        });
      }
    };
  }, []);

  // Return a stable object so consumers' deps don't churn every render.
  return useMemo(() => ({ play, stop, pause, setMuted, getElement }), [play, stop, pause, setMuted, getElement]);
}

// ===== MAIN COMPONENT =====
export default function CatPettingGame() {
  const [phase, setPhase] = useState("room"); // "room" or "petting"
  const [playerWorldPos, setPlayerWorldPos] = useState({ x: 3.5, y: 3.5 });
  const [playerFacing, setPlayerFacing] = useState("down");
  const [cats, setCats] = useState([]); // persistent list: [{ id, catData, x, y, targetX, targetY, wanderUntil, state, restUntil, becameRestingAt }]
  const [activeCatIdx, setActiveCatIdx] = useState(null);
  const [nearbyCatIdx, setNearbyCatIdx] = useState(null);
  const [doorEvent, setDoorEvent] = useState(null); // null or { action: "dropoff"|"pickup", payload, startedAt, durationMs }
  const [muted, setMutedState] = useState(false);

  // ---- AUDIO ----
  // Volumes are fixed - no in-game adjustment. Tune the constants in useAudioBank's BASE_VOLUMES if needed.
  // Note: mute state changes are handled directly by the mute button's onClick (synchronous
  // audio operations stay inside the user-gesture window, which matters for autoplay policy).
  const audio = useAudioBank(0.5, 0.7);
  const click = useCallback(() => audio.play("click"), [audio]);

  // ---- Auto-start background music on game open ----
  // We track the latest muted value via a ref so the listener stays valid across re-renders.
  const muteStateRef = useRef(false);
  useEffect(() => { muteStateRef.current = muted; }, [muted]);

  // The BGM autostart is intentionally aggressive:
  // 1. Try immediately on mount (works on permissive browsers / second load with permission already granted)
  // 2. On every user interaction (pointerdown, keydown, touchstart) attempt to start BGM
  //    until we can confirm it's actually playing. Only THEN remove the listeners.
  // This handles the case where the very first interaction is the mute button (which would
  // otherwise leave BGM silent forever in a single-shot tryPlay design).
  useEffect(() => {
    console.log("[audio] autoplay effect mounted");
    let bgmStarted = false;
    const tryStart = (ev) => {
      if (bgmStarted) return;
      if (muteStateRef.current) { console.log("[audio] tryStart skipped (muted)"); return; }
      if (ev) console.log("[audio] tryStart fired by", ev.type);
      else console.log("[audio] tryStart fired initially");
      audio.play("bgm");
      setTimeout(() => {
        const a = audio.getElement?.("bgm");
        console.log("[audio] post-play check: paused=", a?.paused, "currentTime=", a?.currentTime, "error=", a?.error);
        if (a && !a.paused && !a.error) {
          bgmStarted = true;
          console.log("[audio] ✅ bgm confirmed playing, removing listeners");
          window.removeEventListener("pointerdown", tryStart, true);
          window.removeEventListener("keydown", tryStart, true);
          window.removeEventListener("touchstart", tryStart, true);
        }
      }, 200);
    };
    tryStart();
    window.addEventListener("pointerdown", tryStart, true);
    window.addEventListener("keydown", tryStart, true);
    window.addEventListener("touchstart", tryStart, true);
    return () => {
      console.log("[audio] autoplay effect cleanup");
      window.removeEventListener("pointerdown", tryStart, true);
      window.removeEventListener("keydown", tryStart, true);
      window.removeEventListener("touchstart", tryStart, true);
    };
  }, [audio]);

  const keysRef = useRef({});
  const animFrameRef = useRef(null);
  const canvasRef = useRef(null);
  const playerPosRef = useRef({ x: 3.5, y: 3.5 });
  const nearbyCatIdxRef = useRef(null);

  // petting state
  const [happiness, setHappiness] = useState(0);
  const [mood, setMood] = useState("neutral");
  const [isPetting, setIsPetting] = useState(false);
  const [lastMousePos, setLastMousePos] = useState(null);
  const [petGameState, setPetGameState] = useState("playing");
  const [warningActive, setWarningActive] = useState(false);
  const [tailWag, setTailWag] = useState(false);
  const [catEntering, setCatEntering] = useState(false);
  const catAreaRef = useRef(null);
  const petCountRef = useRef(0);
  const lastPetTimeRef = useRef(0);
  const warningTimerRef = useRef(null);
  const scratchTimerRef = useRef(null);
  const petActiveRef = useRef(false);
  const warningActiveRef = useRef(false);

  const activeCat = activeCatIdx !== null ? cats[activeCatIdx]?.catData : null;

  // ---- COLLISION ----
  const canMoveTo = useCallback((wx, wy) => {
    // wall margins
    const margin = 0.3;
    if (wx < margin || wx > ROOM_TILES_X - margin || wy < margin || wy > ROOM_TILES_Y - margin) return false;
    // furniture (rectangular AABB)
    const playerR = 0.25; // player's collision radius in tiles
    for (const f of FURNITURE) {
      if (!f.blocking) continue;
      const hx = (f.blockHalfX || 0.4) + playerR;
      const hy = (f.blockHalfY || 0.4) + playerR;
      if (Math.abs(wx - f.tx) < hx && Math.abs(wy - f.ty) < hy) return false;
    }
    return true;
  }, []);

  // ---- DAY START ----
  // Build cat schedule deterministically:
  // ---- CONTINUOUS CAT LIFECYCLE ----
  // Refs used by the lifecycle loop to track activity without restarting timers
  const catIdCounterRef = useRef(0);
  const lastDoorActionAtRef = useRef(0);
  const doorBusyRef = useRef(false);

  // Door position in world coordinates (the cat's entry/exit point on the floor)
  const DOOR_X = ROOM_TILES_X * 0.85;
  const DOOR_Y = 0.5;

  // Pick a random spot somewhere inside the room (away from furniture, away from walls)
  // Returns world coords. Used for cat wander targets and initial placement.
  const pickRandomSpot = useCallback(() => {
    // Try several times to find an unblocked position
    for (let tries = 0; tries < 12; tries++) {
      const wx = 1.0 + Math.random() * (ROOM_TILES_X - 2.0);
      const wy = 1.0 + Math.random() * (ROOM_TILES_Y - 2.0);
      // Check no furniture in the way
      let blocked = false;
      for (const f of FURNITURE) {
        if (!f.blocking) continue;
        const hx = (f.blockHalfX || 0.4) + 0.35;
        const hy = (f.blockHalfY || 0.4) + 0.35;
        if (Math.abs(wx - f.tx) < hx && Math.abs(wy - f.ty) < hy) { blocked = true; break; }
      }
      if (!blocked) return { x: wx, y: wy };
    }
    return { x: 3.5, y: 3.5 }; // fallback to center
  }, []);

  // Make a fresh cat object at a given starting position
  const makeCat = useCallback((personality, startX, startY, initialState = "arriving") => {
    const id = ++catIdCounterRef.current;
    const target = pickRandomSpot();
    return {
      id,
      catData: personality,
      x: startX,
      y: startY,
      targetX: target.x,
      targetY: target.y,
      wanderUntil: 0,
      state: initialState,
      restUntil: null,
      becameRestingAt: 0,
    };
  }, [pickRandomSpot]);

  // Trigger a door event. action is "dropoff" or "pickup".
  // For dropoff, payload is the catData (a personality).
  // For pickup, payload is the cat id to be picked up — that cat must already be at the door.
  const triggerDoorEvent = useCallback((action, payload) => {
    if (doorBusyRef.current) return;
    doorBusyRef.current = true;
    setDoorEvent({
      action,
      payload,
      startedAt: Date.now(),
      durationMs: DOOR_EVENT_MS,
    });
  }, []);

  // Decide whether to start a new cat arriving (open the door + drop a new cat at the doorway).
  const maybeSpawnCat = useCallback(() => {
    setCats(prev => {
      const now = Date.now();
      if (doorBusyRef.current) return prev;
      if (now - lastDoorActionAtRef.current < DOOR_COOLDOWN_MS) return prev;
      if (prev.length >= MAX_CATS_IN_ROOM) return prev;

      const shouldSpawn = prev.length < MIN_CATS_IN_ROOM
        || (Math.random() < 0.04);
      if (!shouldSpawn) return prev;

      // Pick a personality not currently present
      const presentTypes = new Set(prev.map(c => c.catData.type));
      const available = CAT_PERSONALITIES.filter(p => !presentTypes.has(p.type));
      const pool = available.length > 0 ? available : CAT_PERSONALITIES;
      const personality = pool[Math.floor(Math.random() * pool.length)];

      // Trigger the door animation; the cat is actually added when the door opens
      triggerDoorEvent("dropoff", personality);
      return prev;
    });
  }, [triggerDoorEvent]);

  // Send a resting cat toward the door so an owner can pick it up.
  // Marks the cat as "leaving" — the canvas movement loop will steer it to the door.
  const maybePickupCat = useCallback(() => {
    setCats(prev => {
      const now = Date.now();
      if (doorBusyRef.current) return prev;
      if (prev.length <= MIN_CATS_IN_ROOM) return prev;
      // Don't pick up if there's already a cat heading for the door
      if (prev.some(c => c.state === "leaving")) return prev;

      const candidates = prev.filter(c => c.state === "resting" && (now - (c.becameRestingAt || 0)) > 20000);
      if (candidates.length === 0) return prev;

      candidates.sort((a, b) => (a.becameRestingAt || 0) - (b.becameRestingAt || 0));
      const target = candidates[0];
      // Start the cat walking toward the door. The door opens when the cat is close.
      return prev.map(c => c.id === target.id
        ? { ...c, state: "leaving", targetX: DOOR_X, targetY: DOOR_Y, wanderUntil: 0 }
        : c
      );
    });
  }, []);

  // ---- LIFECYCLE TIMERS ----
  // Periodically check whether resting cats should become waiting again.
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setCats(prev => {
        let changed = false;
        const next = prev.map(c => {
          if (c.state === "resting" && c.restUntil && now >= c.restUntil) {
            changed = true;
            return { ...c, state: "waiting", restUntil: null };
          }
          return c;
        });
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Periodically maybe spawn a new cat
  useEffect(() => {
    const interval = setInterval(() => maybeSpawnCat(), 5000);
    return () => clearInterval(interval);
  }, [maybeSpawnCat]);

  // Periodically maybe pick up a cat
  useEffect(() => {
    const interval = setInterval(() => maybePickupCat(), PICKUP_CHANCE_INTERVAL);
    return () => clearInterval(interval);
  }, [maybePickupCat]);

  // Initial seed: start the game with 3 cats already in the room.
  useEffect(() => {
    if (cats.length === 0) {
      // Shuffle personalities and pick 3
      const shuffled = [...CAT_PERSONALITIES].sort(() => Math.random() - 0.5);
      const initial = shuffled.slice(0, 3).map(p => {
        const start = pickRandomSpot();
        const c = makeCat(p, start.x, start.y, "waiting");
        // Initial cats are already at their position - target is the same
        return { ...c, targetX: start.x, targetY: start.y, wanderUntil: Date.now() + 2000 + Math.random() * 4000 };
      });
      setCats(initial);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- DOOR EVENT DRIVER ----
  // When the door event completes:
  // - dropoff: the cat appears at the doorway and starts walking inward
  // - pickup: the cat at the door is removed
  useEffect(() => {
    if (!doorEvent) return;
    const remaining = doorEvent.startedAt + doorEvent.durationMs - Date.now();
    const timeout = setTimeout(() => {
      if (doorEvent.action === "dropoff") {
        // Add the new cat at the doorway, walking toward a random spot
        setCats(prev => {
          const target = pickRandomSpot();
          const newCat = makeCat(doorEvent.payload, DOOR_X, DOOR_Y, "arriving");
          newCat.targetX = target.x;
          newCat.targetY = target.y;
          return [...prev, newCat];
        });
      } else if (doorEvent.action === "pickup") {
        // Remove the cat with the matching id (it should be at/near the door)
        setCats(prev => prev.filter(c => c.id !== doorEvent.payload));
      }
      audio.play("chime");
      lastDoorActionAtRef.current = Date.now();
      doorBusyRef.current = false;
      setDoorEvent(null);
    }, Math.max(0, remaining));
    return () => clearTimeout(timeout);
  }, [doorEvent, pickRandomSpot, makeCat, audio]);

  // ---- CAT MOVEMENT LOOP ----
  // Each cat walks toward its targetX/targetY. When it reaches the target:
  // - "arriving": transitions to "waiting", picks a wander delay
  // - "waiting": picks a new wander target after some delay
  // - "resting": picks a new wander target after some delay (more slowly)
  // - "leaving": when close to the door, triggers the door open event and waits to be picked up
  useEffect(() => {
    const TICK_MS = 60; // about 16fps for movement (smooth enough, low cost)
    const interval = setInterval(() => {
      const now = Date.now();
      setCats(prev => {
        let anyChanged = false;
        const next = prev.map((c, idx) => {
          // Don't move the cat currently being petted (so it stays where you left it)
          if (idx === activeCatIdx) return c;

          // Move toward target
          const dx = c.targetX - c.x;
          const dy = c.targetY - c.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const speed = c.state === "leaving" ? CAT_WALK_SPEED * 1.2 : CAT_WALK_SPEED;

          let newX = c.x;
          let newY = c.y;
          let arrivedAtTarget = false;

          if (dist > 0.05) {
            const step = Math.min(speed * (TICK_MS / 1000), dist);
            newX = c.x + (dx / dist) * step;
            newY = c.y + (dy / dist) * step;
            anyChanged = true;
          } else {
            arrivedAtTarget = true;
          }

          // Handle state transitions when target reached
          if (arrivedAtTarget) {
            if (c.state === "arriving") {
              // Switched to waiting
              anyChanged = true;
              return {
                ...c, x: newX, y: newY,
                state: "waiting",
                wanderUntil: now + 3000 + Math.random() * 5000,
              };
            }
            if (c.state === "leaving") {
              // Reached the door — request a pickup door event if not already running
              if (!doorBusyRef.current) {
                triggerDoorEvent("pickup", c.id);
              }
              // Cat stays at door waiting for the pickup event to complete
              return c.x !== newX || c.y !== newY
                ? { ...c, x: newX, y: newY }
                : c;
            }
            // waiting or resting: maybe pick a new wander target
            if ((c.state === "waiting" || c.state === "resting") && now >= (c.wanderUntil || 0)) {
              // Pick a new target nearby OR a new random spot
              const newTarget = pickRandomSpot();
              anyChanged = true;
              const idleMs = c.state === "resting"
                ? 6000 + Math.random() * 8000  // resting cats wander less
                : 3000 + Math.random() * 5000;
              return {
                ...c, x: newX, y: newY,
                targetX: newTarget.x, targetY: newTarget.y,
                wanderUntil: now + idleMs,
              };
            }
          }

          return newX !== c.x || newY !== c.y
            ? { ...c, x: newX, y: newY }
            : c;
        });
        return anyChanged ? next : prev;
      });
    }, TICK_MS);
    return () => clearInterval(interval);
  }, [activeCatIdx, pickRandomSpot, triggerDoorEvent]);

  // ---- WASD MOVEMENT ----
  useEffect(() => {
    if (phase !== "room") return;

    const onKeyDown = (e) => {
      const k = e.key.toLowerCase();
      if (["w", "a", "s", "d"].includes(k)) { keysRef.current[k] = true; e.preventDefault(); }
      if (k === "e" && nearbyCatIdxRef.current !== null) startPetting(nearbyCatIdxRef.current);
    };
    const onKeyUp = (e) => { keysRef.current[e.key.toLowerCase()] = false; };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    const loop = () => {
      const k = keysRef.current;
      let dx = 0, dy = 0;
      if (k.w) dy -= MOVE_SPEED * 0.05;
      if (k.s) dy += MOVE_SPEED * 0.05;
      if (k.a) dx -= MOVE_SPEED * 0.05;
      if (k.d) dx += MOVE_SPEED * 0.05;
      if (dx && dy) { dx *= 0.707; dy *= 0.707; }

      if (dx || dy) {
        const cur = playerPosRef.current;
        let nx = cur.x + dx;
        let ny = cur.y + dy;
        if (canMoveTo(nx, cur.y)) cur.x = nx;
        if (canMoveTo(cur.x, ny)) cur.y = ny;
        playerPosRef.current = { ...cur };
        setPlayerWorldPos({ ...cur });

        if (Math.abs(dx) > Math.abs(dy)) setPlayerFacing(dx > 0 ? "right" : "left");
        else setPlayerFacing(dy > 0 ? "down" : "up");
      }

      animFrameRef.current = requestAnimationFrame(loop);
    };
    animFrameRef.current = requestAnimationFrame(loop);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      keysRef.current = {};
    };
  }, [phase, canMoveTo]);

  // ---- DETECT NEARBY CAT ----
  useEffect(() => {
    if (phase !== "room") { setNearbyCatIdx(null); nearbyCatIdxRef.current = null; return; }
    let closest = null;
    let closestDist = Infinity;
    const playerScreen = worldToScreen(playerWorldPos.x, playerWorldPos.y);
    cats.forEach((c, i) => {
      if (c.state !== "waiting") return;
      const catScreen = worldToScreen(c.x, c.y);
      const dist = Math.sqrt((playerScreen.x - catScreen.x) ** 2 + (playerScreen.y - catScreen.y) ** 2);
      if (dist < INTERACT_DIST && dist < closestDist) {
        closest = i;
        closestDist = dist;
      }
    });
    setNearbyCatIdx(closest);
    nearbyCatIdxRef.current = closest;
  }, [playerWorldPos, phase, cats]);

  // ---- DRAW CANVAS ----
  // Continuous mode: phase is "room" almost always (or "petting" when popup is open;
  // we still draw the room behind the popup so it stays visible).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    let raf;
    const render = () => {
      drawRoom(ctx);

      // furniture sorted by depth (back first)
      const sortedFurn = [...FURNITURE].sort((a, b) => (a.tx + a.ty) - (b.tx + b.ty));
      sortedFurn.forEach(f => drawFurniture(ctx, f));

      // collect entities (cats + player) and sort by depth
      const entities = [];
      cats.forEach((c, i) => {
        entities.push({ type: "cat", tx: c.x, ty: c.y, data: c, idx: i });
      });
      entities.push({
        type: "player",
        tx: playerPosRef.current.x, ty: playerPosRef.current.y,
      });
      entities.sort((a, b) => (a.tx + a.ty) - (b.tx + b.ty));

      const now = Date.now();
      entities.forEach(e => {
        const s = worldToScreen(e.tx, e.ty);
        if (e.type === "cat") {
          const c = e.data;
          drawCat(ctx, s.x, s.y - 4, c.catData.color, c.catData.earColor, c.catData.eyeColor);
          // glow ring only for waiting cats (interactable)
          if (nearbyCatIdx === e.idx && c.state === "waiting") {
            ctx.strokeStyle = "rgba(255, 200, 100, 0.7)";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.ellipse(s.x, s.y, 14, 9, 0, 0, Math.PI * 2);
            ctx.stroke();
          }
          // overlay icon based on state
          let iconKind = null;
          if (c.state === "waiting") iconKind = "wants";
          else if (c.state === "happy") iconKind = "happy";
          else if (c.state === "scratched") iconKind = "scratched";
          // "arriving", "leaving", "resting" get no icon
          if (iconKind) drawCatIcon(ctx, s.x, s.y - 4, iconKind, now);
        } else {
          drawPlayer(ctx, s.x, s.y, playerFacing);
        }
      });

      // Door event overlay: a hand reaches in briefly when the door opens
      if (doorEvent) {
        const t = Math.min(1, Math.max(0, (Date.now() - doorEvent.startedAt) / doorEvent.durationMs));
        drawDoorHand(ctx, t);
      }

      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [cats, nearbyCatIdx, playerFacing, doorEvent]);

  // ---- PETTING LOGIC ----
  const clearTimers = useCallback(() => {
    if (warningTimerRef.current) { clearTimeout(warningTimerRef.current); warningTimerRef.current = null; }
    if (scratchTimerRef.current) { clearTimeout(scratchTimerRef.current); scratchTimerRef.current = null; }
  }, []);

  const finishPetting = useCallback((result) => {
    clearTimers();
    // Briefly show the result state, then transition to "resting".
    // Also pin cat in place so it doesn't drift while the result icon shows.
    setCats(prev => prev.map((c, i) => i === activeCatIdx
      ? { ...c, state: result, targetX: c.x, targetY: c.y, wanderUntil: Date.now() + 2000 }
      : c
    ));
    setWarningActive(false);
    warningActiveRef.current = false;
    setTailWag(false);
    petActiveRef.current = false;
    audio.stop("purr");

    setTimeout(() => {
      // Close the petting popup
      setActiveCatIdx(null);
      setPhase("room");

      // After a brief delay (so the result icon is visible), settle into resting state.
      // The cat stays in the room. After REST_DURATION expires, it becomes "waiting" again.
      setTimeout(() => {
        const restMs = REST_DURATION_MIN + Math.random() * (REST_DURATION_MAX - REST_DURATION_MIN);
        const now = Date.now();
        setCats(prev => prev.map((c, i) => i === activeCatIdx
          ? {
              ...c,
              state: "resting",
              restUntil: now + restMs,
              becameRestingAt: now,
              targetX: c.x, targetY: c.y, // stay put
              wanderUntil: now + 4000 + Math.random() * 4000, // brief pause before wandering
            }
          : c
        ));
      }, 1500);
    }, 800);
  }, [activeCatIdx, clearTimers, audio]);

  const scheduleWarning = useCallback(() => {
    if (!activeCat || activeCat.warningInterval === 0) return;
    clearTimers();
    const jitter = activeCat.warningInterval * 0.3;
    const delay = activeCat.warningInterval + (Math.random() * jitter * 2 - jitter);

    warningTimerRef.current = setTimeout(() => {
      // Cat starts warning: ears flatten, tail wags, eyes narrow (in PettingCat SVG)
      setWarningActive(true);
      warningActiveRef.current = true;
      setTailWag(true);

      // After WARNING_DURATION ms, check whether the player kept petting:
      // - If yes (petActiveRef still true) → cat jumps away, session ends
      // - If no → cat calms down, normal petting can resume, schedule next warning
      scratchTimerRef.current = setTimeout(() => {
        if (petActiveRef.current && warningActiveRef.current) {
          // Player ignored the warning - cat hisses (angry meow) and jumps away
          setWarningActive(false);
          warningActiveRef.current = false;
          setTailWag(false);
          audio.play("hiss");
          setMood("annoyed");
          setPetGameState("scratched");
          setTimeout(() => finishPetting("scratched"), 600);
        } else {
          // Player stopped in time - cat calms, can keep petting
          setWarningActive(false);
          warningActiveRef.current = false;
          setTailWag(false);
          scheduleWarning();
        }
      }, WARNING_DURATION);
    }, delay);
  }, [activeCat, finishPetting, clearTimers, audio]);

  const startPetting = useCallback((catIndex) => {
    setActiveCatIdx(catIndex);
    setHappiness(0);
    setMood("neutral");
    setPetGameState("playing");
    setWarningActive(false);
    warningActiveRef.current = false;
    setTailWag(false);
    petActiveRef.current = false;
    petCountRef.current = 0;
    setIsPetting(false);
    setLastMousePos(null);
    setCatEntering(true);
    setPhase("petting");
    setTimeout(() => setCatEntering(false), 350);
  }, []);

  useEffect(() => {
    if (phase === "petting" && activeCat && !catEntering) scheduleWarning();
    return clearTimers;
  }, [phase, activeCatIdx, catEntering, scheduleWarning, clearTimers]);

  useEffect(() => {
    if (!tailWag) return;
    let raf;
    const animate = () => { setTailWag(t => t); raf = requestAnimationFrame(animate); };
    raf = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf);
  }, [tailWag]);

  // happiness no longer decays when player stops petting -- it stays where it is.
  // (lossRate field on cat data is unused now but kept for potential future tuning)

  useEffect(() => {
    if (!activeCat || warningActive) return;
    const pct = happiness / activeCat.threshold;
    if (pct >= 1) setMood("happy");
    else if (pct > 0.4) setMood("neutral");
  }, [happiness, activeCat, warningActive]);

  useEffect(() => {
    if (!activeCat || phase !== "petting" || petGameState !== "playing") return;
    if (happiness >= activeCat.threshold) {
      audio.play("meow");
      setTimeout(() => finishPetting("happy"), 800);
    }
  }, [happiness, activeCat, phase, petGameState, finishPetting, audio]);

  // ---- PURR LOOP ----
  // Purr plays while the player is actively petting AND the cat is not warning/scratched.
  useEffect(() => {
    if (phase !== "petting") { audio.stop("purr"); return; }
    const happyState = isPetting && !warningActive && petGameState === "playing";
    if (happyState) audio.play("purr");
    else audio.pause("purr");
  }, [isPetting, warningActive, petGameState, phase, audio]);

  const handleMouseMove = useCallback((e) => {
    if (phase !== "petting" || petGameState !== "playing" || !activeCat || catEntering) return;
    if (lastMousePos) {
      const dx = Math.abs(e.clientX - lastMousePos.x);
      const dy = Math.abs(e.clientY - lastMousePos.y);
      const movement = dx + dy;
      if (movement > 2 && movement < 22) {
        const now = Date.now();
        if (now - lastPetTimeRef.current > 60) {
          lastPetTimeRef.current = now;
          setIsPetting(true);
          petActiveRef.current = true;
          petCountRef.current++;
          if (!warningActive) {
            setHappiness(prev => Math.min(activeCat.threshold, prev + activeCat.gainRate));
          } else {
            setHappiness(prev => Math.min(activeCat.threshold, prev + activeCat.gainRate * 0.3));
          }
        }
      } else if (movement >= 22 && !warningActive) {
        setMood("annoyed");
        setHappiness(prev => Math.max(0, prev - 6));
        setTimeout(() => { if (!warningActiveRef.current) setMood("neutral"); }, 600);
      }
    }
    setLastMousePos({ x: e.clientX, y: e.clientY });
  }, [phase, petGameState, activeCat, lastMousePos, catEntering, warningActive]);

  const handleMouseLeave = useCallback(() => {
    setIsPetting(false); petActiveRef.current = false; setLastMousePos(null);
  }, []);

  useEffect(() => {
    if (!isPetting) return;
    const timeout = setTimeout(() => { setIsPetting(false); petActiveRef.current = false; }, 200);
    return () => clearTimeout(timeout);
  }, [lastMousePos, isPetting]);

  // ===== RENDER =====
  // Whole game is rendered inside a fixed 320x200 logical viewport, scaled to fit.
  // We use CSS to size the viewport to fit the screen while preserving 320:200 aspect.
  // Coordinates inside this viewport are 1px = 1 game pixel.

  const VIEW_W = 320;
  const VIEW_H = 200;

  const outerWrapStyle = {
    width: "100%", height: "100%", minHeight: 480,
    display: "flex", alignItems: "center", justifyContent: "center",
    background: "#1a1410",
    fontFamily: "monospace", userSelect: "none",
    overflow: "hidden",
  };

  // The fixed viewport that holds all game UI. Size on screen = min(width-fit, height-fit)
  // preserving the 320:200 (8:5) aspect.
  const viewportStyle = {
    position: "relative",
    width: "min(98vw, calc((100vh - 16px) * 1.6))",
    height: "min(61.25vw, calc(100vh - 16px))",
    background: "linear-gradient(180deg, rgb(250,240,225) 0%, rgb(252,232,215) 100%)",
    border: "2px solid #5D4037",
    overflow: "hidden",
    imageRendering: "pixelated",
  };

  // Pixel font sizes are in vh-relative units so they scale with the viewport.
  // We use cqi (container query inline size) when available; fall back to vw.
  // Specifically, 1 game pixel ≈ viewport_height / 200.
  // For text, we'll just use small fixed-vh values.
  const px = (gamePx) => `calc(${gamePx} * (100% / ${VIEW_H}))`; // unused — for reference

  // ---- mute toggle button (top-right, visible in all phases) ----
  // Single click toggles mute. When muted, a diagonal slash is drawn over the ♪ icon.
  // The click handler does audio work SYNCHRONOUSLY (not via effect) so it stays inside
  // the browser's user-gesture window — important for unblocking autoplay on first click.
  const onMuteClick = useCallback(() => {
    const willBeMuted = !muted;
    if (willBeMuted) {
      // Going to muted: pause everything immediately. No click sound (we're silencing).
      audio.setMuted(true);
    } else {
      // Going to unmuted: unblock audio engine, then resume bgm + play click confirmation.
      audio.setMuted(false);
      audio.play("click");
      audio.play("bgm");
    }
    setMutedState(willBeMuted);
  }, [muted, audio]);

  const muteBtn = (
    <button
      onClick={onMuteClick}
      title={muted ? "Unmute" : "Mute"}
      style={{
        position: "absolute", top: "2.5%", right: "2.5%", zIndex: 95,
        width: "min(30px, 9%)", height: "min(24px, 7%)",
        background: "rgba(255, 245, 230, 0.85)",
        border: "1.5px solid #5D4037",
        color: "#5D4037",
        cursor: "pointer", padding: 0,
        fontFamily: "monospace", fontWeight: 700,
        display: "flex", alignItems: "center", justifyContent: "center",
        lineHeight: 1, overflow: "hidden",
      }}
    >
      <span style={{ position: "relative", display: "inline-block", lineHeight: 1, fontSize: "min(0.7rem, 2vh)" }}>
        ♪
        {muted && (
          <span style={{
            position: "absolute",
            top: "50%", left: "-25%",
            width: "150%", height: "2px",
            background: "#D32F2F",
            transform: "translateY(-50%) rotate(-30deg)",
            transformOrigin: "center",
            pointerEvents: "none",
          }}/>
        )}
      </span>
    </button>
  );

  // ---- room + (optional) petting popup ----
  const showPetPopup = phase === "petting" && activeCat;

  return (
    <div style={outerWrapStyle}>
      <div style={viewportStyle}>
        <style>{`
          @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }
        `}</style>

        {/* canvas room - fills the viewport */}
        <canvas
          ref={canvasRef}
          width={ROOM_W} height={ROOM_H}
          style={{
            display: "block",
            width: "100%", height: "100%",
            imageRendering: "pixelated",
          }}
        />

        {/* PET POPUP - rendered as a window over the room */}
        {showPetPopup && (
          <div style={{
              position: "absolute", inset: 0,
              background: "rgba(40,30,25,0.55)",
              display: "flex", alignItems: "center", justifyContent: "center",
              zIndex: 50,
            }}
          >
            <div style={{
                position: "relative",
                width: "75%", height: "82%",
                background: "#FFF5E6",
                border: "1.5px solid #5D4037",
                boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
                display: "flex", flexDirection: "column", alignItems: "center",
                padding: "4% 4% 3%",
                boxSizing: "border-box",
              }}
            >
              {/* slim decorative top bar (no text) */}
              <div style={{
                position: "absolute", top: -1, left: -1, right: -1,
                height: "4%", background: "#5D4037",
              }}/>

              {/* cat petting area - takes full popup */}
              <div ref={catAreaRef} onMouseMove={handleMouseMove} onMouseLeave={handleMouseLeave}
                style={{
                  flex: 1, width: "100%",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  position: "relative",
                  cursor: petGameState === "scratched" ? "not-allowed" : isPetting ? "grabbing" : "pointer",
                }}>
                <div style={{
                  transition: "transform 0.3s ease, opacity 0.3s ease",
                  transform: catEntering ? "scale(0.7)" : isPetting && !warningActive ? "scale(1.03)" : "scale(1)",
                  opacity: catEntering ? 0 : 1,
                  width: "70%", maxWidth: "60%",
                }}>
                  <PettingCat
                    mood={petGameState === "scratched" ? "annoyed" : mood}
                    color={activeCat.color}
                    earColor={activeCat.earColor}
                    eyeColor={activeCat.eyeColor}
                    warning={warningActive && petGameState !== "scratched"}
                    scratched={petGameState === "scratched"}
                    tailWag={tailWag}
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* mute toggle */}
        {muteBtn}

      </div>
    </div>
  );
}
