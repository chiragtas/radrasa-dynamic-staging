(function () {
  'use strict';
  // Version stamp: type window.lookOnVersion in the browser console on a product page to see which build the store runs.
  if (typeof window !== 'undefined') { if (window.lookOnLoaded) return; window.lookOnLoaded = true; window.lookOnVersion = '2.2-blocks'; }

  function el(root, sel) { return root.querySelector(sel); }

  // Default wording; the merchant's own texts (lookOn > Texts in Shopify admin) come from the server and replace these.
  var DEFAULT_TEXTS = {"heading":"Try it on","subheading":"Add a front-facing photo to see this on you.","chooseButton":"Choose photo to try on {category}","selfieButton":"Take selfie","captureButton":"Capture","cancelButton":"Cancel","consent":"This is a photo of me and I'm 18 or over. I understand it is sent to an AI service to make the preview and is not saved.","privacy":"Previews are AI-made and approximate: colour, size and fit will differ a little from the real product.","consentRequired":"Please tick the box above first.","stillLoading":"One moment, the try-on is still loading.","loadingPhoto":"Loading your photo…","checkingPhoto":"Checking your photo…","generating":"Styling your preview… this can take up to a minute.","loaderLabel":"Creating your preview…","cameraPrompt":"Look at the camera and press Capture.","cameraStarting":"The camera is still starting. Try again in a second.","cameraUnavailable":"The camera is not available. Please use Choose photo instead.","photoUnreadable":"Sorry, that image could not be loaded.","showOriginal":"Show my original photo","showPreview":"Show the preview","previewOption":"Preview this option","download":"Download","keepFace":"Keep my real face exactly as in my photo","resultDone":"AI preview of {product} on you.","resultFaceKept":"AI preview of {product}. Your real face is kept exactly as in your photo; the rest is AI-made.","resultFaceMissing":"AI preview of {product}. We could not find your face in the photo, so the face may differ slightly. A clear, front-facing photo works best.","resultFaceNotAligned":"AI preview of {product}. We could not line your face up exactly, so the plain AI picture is shown.","resultFocus":"AI preview of {product} on you. Only the {area} area is AI-made; the rest is your original photo.","resultFocusMissed":"The AI did not place {product} clearly this time. Please try again, ideally with a sharper, front-facing photo.","tryAnyway":"Try anyway with this photo","noFace":"We could not find a face in that photo. Please use a clear, front-facing photo with your whole face in view.","faceSmall":"Your face looks very small in this photo. Please move closer or use a closer photo.","earsCut":"Your ears are cut off in this photo. Please use a photo that shows both ears.","noNeck":"We cannot see enough of your neck and shoulders. Please use a photo that shows your neck and shoulders.","noHand":"We could not find a hand or wrist in that photo. This product needs a photo of your wrist and hand (a face photo will not work).","wristCut":"Your wrist is cut off in this photo. Please show your whole wrist and hand.","fingersCut":"Your fingers are cut off in this photo. Please show your whole hand with the fingers visible.","outOfCredits":"Try-on is not available right now. Please check back soon.","genericError":"Something went wrong. Please try again.","unavailable":"Try-on is temporarily unavailable."};
  function makeTx(get) {
    return function (key, vars) {
      var all = get() || {}, t = typeof all[key] === 'string' && all[key] ? all[key] : (DEFAULT_TEXTS[key] || '');
      return t.replace(/\{(\w+)\}/g, function (m, k) { return vars && vars[k] != null ? String(vars[k]) : ''; }).replace(/\s+/g, ' ').trim();
    };
  }

  // ================= keep the shopper's real face =================
  // The AI sometimes subtly changes the face. For products that do not cover the face, the shopper's real face (eyebrows down)
  // is put back on top of the AI picture, but ONLY when the two faces line up well; otherwise the plain AI picture is shown.
  var VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
  var MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
  var HI_SIDE = 1024;          // size of the shopper's photo kept for the face (sharper than what the AI receives)
  var MERGE_MAX_ERR = 0.10;    // beyond this average landmark mismatch (fraction of face width) the AI drew a different face/pose: no merge
  var OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];
  var BROWS = [70,63,105,66,107,300,293,334,296,336];

  var landmarkerPromise = null;
  function getLandmarker() {
    if (window.__PTN_LANDMARKER__) return Promise.resolve(window.__PTN_LANDMARKER__); // test seam
    if (!landmarkerPromise) {
      landmarkerPromise = import(VISION + '/vision_bundle.mjs').then(function (mod) {
        return mod.FilesetResolver.forVisionTasks(VISION + '/wasm').then(function (files) {
          return mod.FaceLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: MODEL }, runningMode: 'IMAGE', numFaces: 1 });
        });
      });
      landmarkerPromise.catch(function () { landmarkerPromise = null; });
    }
    return landmarkerPromise;
  }
  function detectFace(c) {
    return Promise.resolve().then(getLandmarker).then(function (lm) { var r = lm.detect(c); return (r.faceLandmarks && r.faceLandmarks[0]) || null; }).catch(function () { return null; });
  }


  // ---------- is the right body part in the photo? (checked on the shopper's device, before any AI call) ----------
  var HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
  var handsPromise = null;
  function getHands() {
    if (window.__PTN_HANDS__) return Promise.resolve(window.__PTN_HANDS__); // test seam
    if (!handsPromise) {
      handsPromise = import(VISION + '/vision_bundle.mjs').then(function (mod) {
        return mod.FilesetResolver.forVisionTasks(VISION + '/wasm').then(function (files) {
          return mod.HandLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: HAND_MODEL }, runningMode: 'IMAGE', numHands: 1 });
        });
      });
      handsPromise.catch(function () { handsPromise = null; });
    }
    return handsPromise;
  }
  // Each returns { state: 'ok', points } | { state: 'none' } (looked, found nothing) | { state: 'unavailable' } (the detector could not run).
  function findFace(c) {
    return Promise.resolve().then(getLandmarker).then(function (lm) {
      var r = lm.detect(c), L = r.faceLandmarks && r.faceLandmarks[0];
      return L ? { state: 'ok', points: L } : { state: 'none' };
    }).catch(function () { return { state: 'unavailable' }; });
  }
  function findHand(c) {
    return Promise.resolve().then(getHands).then(function (hm) {
      var r = hm.detect(c), P = r.landmarks && r.landmarks[0];
      return P ? { state: 'ok', points: P } : { state: 'none' };
    }).catch(function () { return { state: 'unavailable' }; });
  }


  // What the product needs the photo to show: face | ears | neck | wrist | hand. Resolves { ok, face?, msg? }.
  // If the detector cannot run (blocked, offline) the shopper is never stopped: ok is true.
  function checkPhoto(needs, c, tx) {
    var MSG = { face: tx('noFace'), small: tx('faceSmall'), ears: tx('earsCut'), neck: tx('noNeck'), hand: tx('noHand'), wrist: tx('wristCut'), fingers: tx('fingersCut') };
    if (needs === 'wrist' || needs === 'hand') {
      return findHand(c).then(function (h) {
        if (h.state === 'unavailable') return { ok: true };
        if (h.state === 'none') return { ok: false, msg: MSG.hand };
        var P = h.points, inFrame = function (i) { return P[i].x > 0.01 && P[i].x < 0.99 && P[i].y > 0.01 && P[i].y < 0.99; };
        if (needs === 'wrist' && !inFrame(0)) return { ok: false, msg: MSG.wrist };
        if (needs === 'hand' && ![4, 8, 12, 16, 20].every(inFrame)) return { ok: false, msg: MSG.fingers };
        return { ok: true };
      });
    }
    return findFace(c).then(function (f) {
      if (f.state === 'unavailable') return { ok: true };
      if (f.state === 'none') return { ok: false, msg: MSG.face };
      var L = f.points, w = Math.abs(L[454].x - L[234].x), h = L[152].y - L[10].y;
      if (w < 0.14) return { ok: false, msg: MSG.small };
      if (needs === 'ears' && (L[234].x < 0.01 || L[454].x > 0.99)) return { ok: false, msg: MSG.ears };
      if (needs === 'neck' && L[152].y + 0.35 * h > 0.99) return { ok: false, msg: MSG.neck };
      return { ok: true, face: L };
    });
  }

  // Affine transform mapping three source points onto three destination points: [a,b,c,d,e,f] for canvas setTransform.
  function solveAffine(S, D) {
    var M = [[S[0][0], S[0][1], 1], [S[1][0], S[1][1], 1], [S[2][0], S[2][1], 1]];
    function solve(rhs) {
      var A = M.map(function (r, i) { return r.concat(rhs[i]); });
      for (var i = 0; i < 3; i++) {
        var p = i;
        for (var r = i + 1; r < 3; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
        var t = A[i]; A[i] = A[p]; A[p] = t;
        if (Math.abs(A[i][i]) < 1e-9) return null;
        for (var r2 = i + 1; r2 < 3; r2++) { var f = A[r2][i] / A[i][i]; for (var c = i; c < 4; c++) A[r2][c] -= f * A[i][c]; }
      }
      var x = [0, 0, 0];
      for (var i2 = 2; i2 >= 0; i2--) { var s = A[i2][3]; for (var c2 = i2 + 1; c2 < 3; c2++) s -= A[i2][c2] * x[c2]; x[i2] = s / A[i2][i2]; }
      return x;
    }
    var X = solve(D.map(function (p) { return p[0]; })), Y = solve(D.map(function (p) { return p[1]; }));
    if (!X || !Y) return null;
    return [X[0], Y[0], X[1], Y[1], X[2], Y[2]];
  }

  // The face to keep: the face oval, cut off at the eyebrows (so hair, fringe and hats stay AI-made), pulled in a little.
  function facePolygon(L, w, h) {
    var topY = L[10].y * h, chinY = L[152].y * h, faceH = chinY - topY;
    var browY = Math.min.apply(null, BROWS.map(function (i) { return L[i].y * h; }));
    var cut = browY - 0.03 * faceH;
    var pts = OVAL.map(function (i) { return [L[i].x * w, Math.max(L[i].y * h, cut)]; });
    var cx = 0, cy = 0;
    pts.forEach(function (p) { cx += p[0]; cy += p[1]; });
    cx /= pts.length; cy /= pts.length;
    return pts.map(function (p) { return [cx + (p[0] - cx) * 0.94, cy + (p[1] - cy) * 0.94]; });
  }

  // Feathered mask using the shadow trick (works in Safari, unlike ctx.filter).
  function softMask(w, h, poly, blur) {
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var x = c.getContext('2d'), OFF = w + blur * 4;
    x.shadowColor = '#000'; x.shadowBlur = blur; x.shadowOffsetX = OFF; x.fillStyle = '#000';
    x.beginPath();
    poly.forEach(function (p, i) { if (i) x.lineTo(p[0] - OFF, p[1]); else x.moveTo(p[0] - OFF, p[1]); });
    x.closePath(); x.fill();
    return c;
  }

  function meanRGB(ctx, cx, cy, r) {
    var x = Math.max(0, Math.round(cx - r)), y = Math.max(0, Math.round(cy - r)), s = Math.max(2, Math.round(r * 2));
    var d = ctx.getImageData(x, y, s, s).data, n = 0, a = 0, b = 0, c = 0;
    for (var i = 0; i < d.length; i += 4) { if (d[i + 3] < 250) continue; a += d[i]; b += d[i + 1]; c += d[i + 2]; n++; }
    return n ? [a / n, b / n, c / n] : null;
  }

  // Points of the face mesh used to warp the real face onto the AI's face shape (outline, brows, eyes, nose, mouth, cheeks).
  var MESH = OVAL.concat(BROWS, [33,133,159,145,263,362,386,374, 1,2,98,327,168,6,195,5, 61,291,0,17,13,14,37,267,84,314,78,308, 50,280,205,425,116,345,117,346]);
  MESH = MESH.filter(function (v, i) { return MESH.indexOf(v) === i; });

  // Delaunay triangulation (Bowyer-Watson) of a few dozen points. Returns triples of point indexes.
  function delaunay(pts) {
    var n = pts.length, minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    pts.forEach(function (p) { minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]); maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]); });
    var m = Math.max(maxX - minX, maxY - minY, 1), cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    var P = pts.concat([[cx - 20 * m, cy - m], [cx, cy + 20 * m], [cx + 20 * m, cy - m]]);
    var tris = [[n, n + 1, n + 2]];
    function inCircle(p, a, b, c) {
      var ax = a[0] - p[0], ay = a[1] - p[1], bx = b[0] - p[0], by = b[1] - p[1], cx2 = c[0] - p[0], cy2 = c[1] - p[1];
      var det = (ax * ax + ay * ay) * (bx * cy2 - cx2 * by) - (bx * bx + by * by) * (ax * cy2 - cx2 * ay) + (cx2 * cx2 + cy2 * cy2) * (ax * by - bx * ay);
      var orient = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      return orient > 0 ? det > 0 : det < 0;
    }
    for (var i = 0; i < n; i++) {
      var bad = [], keep = [];
      tris.forEach(function (t) { (inCircle(P[i], P[t[0]], P[t[1]], P[t[2]]) ? bad : keep).push(t); });
      var edges = {};
      bad.forEach(function (t) {
        [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]].forEach(function (e) {
          var k = Math.min(e[0], e[1]) + '_' + Math.max(e[0], e[1]);
          edges[k] = edges[k] ? null : e;
        });
      });
      Object.keys(edges).forEach(function (k) { if (edges[k]) keep.push([edges[k][0], edges[k][1], i]); });
      tris = keep;
    }
    return tris.filter(function (t) { return t[0] < n && t[1] < n && t[2] < n; });
  }

  // Put the real face back onto the AI picture. photo: canvas with the shopper's photo. aiImg: AI result (image or canvas).
  // LP / LA: face landmarks of each. The real face is WARPED onto the AI's face shape (piece by piece), so small changes the AI made
  // to the head shape or pose do not matter. Returns a canvas, or null only when the faces differ too much to match at all.
  function mergeFace(photo, aiImg, LP, LA) {
    var aw = aiImg.naturalWidth || aiImg.width, ah = aiImg.naturalHeight || aiImg.height;
    var k = Math.max(1, HI_SIDE / Math.max(aw, ah));
    var ow = Math.round(aw * k), oh = Math.round(ah * k);
    var anchors = function (L, w, h) {
      return [[L[33].x * w, L[33].y * h], [L[263].x * w, L[263].y * h], [((L[13].x + L[14].x) / 2) * w, ((L[13].y + L[14].y) / 2) * h]];
    };
    var T = solveAffine(anchors(LP, photo.width, photo.height), anchors(LA, ow, oh));
    if (!T) return null;

    // Sanity gate: after the simple alignment, how far off is the AI's face? A little is fixed by the warp; a lot means the AI drew
    // a different face or pose, and nothing sensible can be pasted.
    var aFaceW = Math.hypot((LA[454].x - LA[234].x) * ow, (LA[454].y - LA[234].y) * oh) || 1, err = 0;
    var check = [1, 152, 10, 234, 454, 61, 291];
    check.forEach(function (i) {
      var x = LP[i].x * photo.width, y = LP[i].y * photo.height;
      err += Math.hypot(T[0] * x + T[2] * y + T[4] - LA[i].x * ow, T[1] * x + T[3] * y + T[5] - LA[i].y * oh);
    });
    if (err / check.length / aFaceW > MERGE_MAX_ERR) return null;

    var out = document.createElement('canvas'); out.width = ow; out.height = oh;
    var o = out.getContext('2d');
    o.imageSmoothingQuality = 'high';
    o.drawImage(aiImg, 0, 0, ow, oh);

    // Warp: same triangles on both faces; each triangle of the real photo is drawn onto the matching triangle of the AI face.
    var src = MESH.map(function (i) { return [LP[i].x * photo.width, LP[i].y * photo.height]; });
    var dst = MESH.map(function (i) { return [LA[i].x * ow, LA[i].y * oh]; });
    var f = document.createElement('canvas'); f.width = ow; f.height = oh;
    var fc = f.getContext('2d');
    fc.imageSmoothingQuality = 'high';
    delaunay(src).forEach(function (t) {
      var S = [src[t[0]], src[t[1]], src[t[2]]], D = [dst[t[0]], dst[t[1]], dst[t[2]]];
      var A = solveAffine(S, D);
      if (!A) return;
      var cx = (D[0][0] + D[1][0] + D[2][0]) / 3, cy = (D[0][1] + D[1][1] + D[2][1]) / 3;
      fc.save();
      fc.beginPath();
      D.forEach(function (p, i) { // grown by under a pixel so neighbouring triangles leave no hairline gaps
        var dx = p[0] - cx, dy = p[1] - cy, len = Math.hypot(dx, dy) || 1, q = [p[0] + (dx / len) * 0.8, p[1] + (dy / len) * 0.8];
        if (i) fc.lineTo(q[0], q[1]); else fc.moveTo(q[0], q[1]);
      });
      fc.closePath();
      fc.clip();
      fc.setTransform(A[0], A[1], A[2], A[3], A[4], A[5]);
      fc.drawImage(photo, 0, 0);
      fc.restore();
    });

    var poly = facePolygon(LA, ow, oh);
    var faceW = aFaceW;

    // Match skin tone to the AI picture around the cheeks so the join is not visible.
    try {
      var r = Math.max(4, faceW * 0.05), gain = [0, 0, 0], got = 0;
      [50, 280].forEach(function (i) {
        var a = meanRGB(o, LA[i].x * ow, LA[i].y * oh, r), b = meanRGB(fc, LA[i].x * ow, LA[i].y * oh, r);
        if (a && b) { for (var c = 0; c < 3; c++) gain[c] += a[c] / Math.max(1, b[c]); got++; }
      });
      if (got) {
        gain = gain.map(function (g) { return Math.min(1.25, Math.max(0.8, g / got)); });
        var xs = poly.map(function (p) { return p[0]; }), ys = poly.map(function (p) { return p[1]; });
        var bx = Math.max(0, Math.floor(Math.min.apply(null, xs) - 8)), by = Math.max(0, Math.floor(Math.min.apply(null, ys) - 8));
        var bw = Math.min(ow - bx, Math.ceil(Math.max.apply(null, xs) - bx + 8)), bh = Math.min(oh - by, Math.ceil(Math.max.apply(null, ys) - by + 8));
        var img = fc.getImageData(bx, by, bw, bh), d = img.data;
        for (var i2 = 0; i2 < d.length; i2 += 4) { d[i2] = Math.min(255, d[i2] * gain[0]); d[i2 + 1] = Math.min(255, d[i2 + 1] * gain[1]); d[i2 + 2] = Math.min(255, d[i2 + 2] * gain[2]); }
        fc.putImageData(img, bx, by);
      }
    } catch (e) { /* tone match is optional */ }

    var mask = softMask(ow, oh, poly, Math.max(4, faceW * 0.06));
    fc.globalCompositeOperation = 'destination-in';
    fc.drawImage(mask, 0, 0);
    fc.globalCompositeOperation = 'source-over';
    o.drawImage(f, 0, 0);
    return out;
  }


  // ================= small items: close-up crop in, only the item's area pasted back =================
  // For nose pins, earrings and necklaces the AI gets a close-up of just that part of the face/neck, and only a soft-edged
  // patch around the nostril / earlobes / neck is copied from its answer onto the shopper's ORIGINAL photo. So the rest of the
  // photo can never change, and the item cannot end up anywhere else (a nose pin cannot land on an ear: the ears are not even sent).
  function faceGeom(L, w, h) {
    var P = function (i) { return [L[i].x * w, L[i].y * h]; };
    var l = P(234), r = P(454), top = P(10), chin = P(152);
    var faceW = Math.hypot(r[0] - l[0], r[1] - l[1]) || 1, faceH = Math.hypot(chin[0] - top[0], chin[1] - top[1]) || 1;
    var browY = Math.min.apply(null, BROWS.map(function (i) { return L[i].y * h; }));
    return { P: P, l: l, r: r, top: top, chin: chin, faceW: faceW, faceH: faceH, browY: browY, cx: (l[0] + r[0]) / 2 };
  }

  // Square crop (in photo pixels) around the focus area, kept inside the photo.
  function focusRect(focus, L, w, h) {
    var g = faceGeom(L, w, h), x0, x1, y0, y1;
    var nose = g.P(1);
    if (focus === 'nose') {
      var s0 = 0.8 * g.faceW;
      x0 = nose[0] - s0 / 2; x1 = nose[0] + s0 / 2; y0 = nose[1] - s0 * 0.55; y1 = nose[1] + s0 * 0.45;
    } else {
      x0 = Math.min(g.l[0], g.r[0]) - 0.4 * g.faceW; x1 = Math.max(g.l[0], g.r[0]) + 0.4 * g.faceW;
      y0 = focus === 'neck' ? nose[1] : g.browY - 0.1 * g.faceH;
      y1 = focus === 'ears' ? g.chin[1] + 0.45 * g.faceH : g.chin[1] + 1.3 * g.faceH;
      if (focus === 'neck' || focus === 'ears+neck') { var mid = (x0 + x1) / 2, half = Math.max((x1 - x0) / 2, 1.15 * g.faceW); x0 = mid - half; x1 = mid + half; }
    }
    var side = Math.min(Math.max(x1 - x0, y1 - y0), w, h);
    var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    var x = Math.round(Math.min(Math.max(0, cx - side / 2), w - side)), y = Math.round(Math.min(Math.max(0, cy - side / 2), h - side));
    return { x: x, y: y, side: Math.floor(side) };
  }

  // Soft-edged mask (photo-sized) covering only where the item goes.
  function focusMask(focus, L, w, h) {
    var g = faceGeom(L, w, h), blur = Math.max(3, g.faceW * 0.05);
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var x = c.getContext('2d'), OFF = w + blur * 4;
    x.shadowColor = '#000'; x.shadowBlur = blur; x.shadowOffsetX = OFF; x.fillStyle = '#000';
    var ell = function (cx, cy, rx, ry) { x.beginPath(); x.ellipse(cx - OFF, cy, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2); x.fill(); };
    if (focus === 'nose') {
      var a = g.P(98), b = g.P(327), tip = g.P(1);
      ell((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 * 0.6 + tip[1] * 0.4, Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.75 + g.faceW * 0.04, g.faceW * 0.14);
    }
    if (focus === 'ears' || focus === 'ears+neck') {
      [[g.l, -1], [g.r, 1]].forEach(function (e) {
        var sideSign = g.l[0] < g.r[0] ? e[1] : -e[1];
        ell(e[0][0] + sideSign * 0.08 * g.faceW, e[0][1] + 0.35 * g.faceH, 0.24 * g.faceW, 0.55 * g.faceH);
      });
    }
    if (focus === 'neck' || focus === 'ears+neck') {
      var top = g.chin[1] - 0.05 * g.faceH;
      x.beginPath(); x.rect(g.cx - 1.25 * g.faceW - OFF, top, 2.5 * g.faceW, h - top + blur * 4); x.fill();
    }
    return c;
  }

  function grayOf(src, sx, sy, sw, sh, n) {
    var c = document.createElement('canvas'); c.width = n; c.height = n;
    var x = c.getContext('2d'); x.drawImage(src, sx, sy, sw, sh, 0, 0, n, n);
    var d = x.getImageData(0, 0, n, n).data, g = new Float32Array(n * n);
    for (var i = 0; i < g.length; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    return g;
  }

  // The AI sometimes shifts its picture by a few pixels. Find the shift that best lines its crop up with the real crop,
  // judged only OUTSIDE the mask (where nothing should have changed). Returns { dx, dy } in crop pixels and how well it matches.
  function alignShift(photo, rect, aiImg, mask) {
    var n = 64, R = 4;
    var a = grayOf(photo, rect.x, rect.y, rect.side, rect.side, n);
    var aw = aiImg.naturalWidth || aiImg.width, ah = aiImg.naturalHeight || aiImg.height;
    var b = grayOf(aiImg, 0, 0, aw, ah, n);
    var mc = document.createElement('canvas'); mc.width = n; mc.height = n;
    var mx = mc.getContext('2d'); mx.drawImage(mask, rect.x, rect.y, rect.side, rect.side, 0, 0, n, n);
    var md = mx.getImageData(0, 0, n, n).data;
    var best = { dx: 0, dy: 0, err: Infinity };
    for (var dy = -R; dy <= R; dy++) for (var dx = -R; dx <= R; dx++) {
      var sum = 0, cnt = 0;
      for (var y = R; y < n - R; y++) for (var x = R; x < n - R; x++) {
        if (md[(y * n + x) * 4 + 3] > 10) continue;
        sum += Math.abs(a[y * n + x] - b[(y + dy) * n + (x + dx)]); cnt++;
      }
      var e = cnt ? sum / cnt : 0;
      if (e < best.err) best = { dx: dx, dy: dy, err: e };
    }
    var k = rect.side / n;
    return { dx: best.dx * k, dy: best.dy * k, err: best.err };
  }

  // Build the final picture: the shopper's photo with only the masked area taken from the AI's crop.
  function pasteFocus(photo, rect, aiImg, mask) {
    var w = photo.width, h = photo.height;
    var shift = alignShift(photo, rect, aiImg, mask);
    var patch = document.createElement('canvas'); patch.width = w; patch.height = h;
    var p = patch.getContext('2d'); p.imageSmoothingQuality = 'high';
    p.drawImage(photo, 0, 0);
    var aw = aiImg.naturalWidth || aiImg.width, ah = aiImg.naturalHeight || aiImg.height;
    p.drawImage(aiImg, 0, 0, aw, ah, rect.x - shift.dx, rect.y - shift.dy, rect.side, rect.side);
    p.globalCompositeOperation = 'destination-in';
    p.drawImage(mask, 0, 0);
    p.globalCompositeOperation = 'source-over';
    var out = document.createElement('canvas'); out.width = w; out.height = h;
    var o = out.getContext('2d');
    o.drawImage(photo, 0, 0);
    o.drawImage(patch, 0, 0);
    // Did anything visible appear inside the mask?
    var n = 48, before = grayOf(photo, rect.x, rect.y, rect.side, rect.side, n), after = grayOf(out, rect.x, rect.y, rect.side, rect.side, n), peak = 0;
    for (var i = 0; i < before.length; i++) peak = Math.max(peak, Math.abs(before[i] - after[i]));
    return { canvas: out, changed: peak > 18, misaligned: shift.err > 22 };
  }

  function cropPayload(photo, rect, side) {
    var c = document.createElement('canvas'); c.width = side; c.height = side;
    var x = c.getContext('2d'); x.imageSmoothingQuality = 'high';
    x.drawImage(photo, rect.x, rect.y, rect.side, rect.side, 0, 0, side, side);
    return { mime: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.95).split(',')[1], width: side, height: side };
  }

  if (typeof globalThis !== 'undefined' && globalThis.__PTN_TEST__) {
    globalThis.__PTN_TEST__.mergeFace = mergeFace;
    globalThis.__PTN_TEST__.solveAffine = solveAffine;
    globalThis.__PTN_TEST__.delaunay = delaunay;
    globalThis.__PTN_TEST__.checkPhoto = checkPhoto;
    globalThis.__PTN_TEST__.focusRect = focusRect;
    globalThis.__PTN_TEST__.pasteFocus = pasteFocus;
    globalThis.__PTN_TEST__.focusMask = focusMask;
  }

  function loadImg(src) {
    return new Promise(function (res, rej) {
      var img = new Image();
      img.onload = function () { res(img); };
      img.onerror = function () { rej(new Error('The preview image could not be loaded.')); };
      img.src = src;
    });
  }

  function init(root) {
    if (root.dataset.ready) return;
    root.dataset.ready = '1';

    // Existing theme-editor settings can retain an empty api_url even after the
    // extension schema gets a default. Keep the storefront working without
    // requiring the merchant to edit the block settings manually.
    var api = (root.dataset.api || 'https://radrasa-dynamic-staging.vercel.app').replace(/\/$/, '');
    var shop = root.dataset.shop || (window.Shopify && Shopify.shop) || '', handle = root.dataset.handle || '', hint = root.dataset.category || '';
    // Some themes do not expose Shopify.shop to app-embed scripts. The
    // storefront host is still safe to use because the API accepts only
    // *.myshopify.com domains.
    if (!shop && typeof location !== 'undefined' && /\.myshopify\.com$/i.test(location.hostname)) shop = location.hostname;
    // App embeds target <body>. Some themes do not expose Liquid's `product`
    // object there, so recover the handle from the current product URL.
    if (!handle && typeof location !== 'undefined') {
      var pathMatch = location.pathname.match(/\/products\/([^/?#]+)/i);
      if (pathMatch) {
        try { handle = decodeURIComponent(pathMatch[1]); } catch (_) { handle = pathMatch[1]; }
      }
    }
    if (!handle && window.ShopifyAnalytics && ShopifyAnalytics.meta && ShopifyAnalytics.meta.product) {
      handle = ShopifyAnalytics.meta.product.handle || '';
    }
    var consent = el(root, '.ptn-consent-box'), status = el(root, '.ptn-status'), stage = el(root, '.ptn-stage');
    var result = el(root, '.ptn-result'), toggle = el(root, '.ptn-toggle'), regen = el(root, '.ptn-regen'), download = el(root, '.ptn-download');
    var selfieBtn = el(root, '.ptn-selfie'), cam = el(root, '.ptn-camera'), video = el(root, '.ptn-video');
    var snap = el(root, '.ptn-snap'), camClose = el(root, '.ptn-cam-close'), selfieFile = el(root, '.ptn-selfie-file');
    var label = el(root, '.ptn-btn-label'), hintEl = el(root, '.ptn-hint'), keepWrap = el(root, '.ptn-keep'), keepBox = el(root, '.ptn-keepface'), anyway = el(root, '.ptn-anyway');

    // ---- who the shopper is: a random id kept in this browser, the email they gave, their store account if signed in ----
    function keep(k, v) { try { if (v === undefined) return window.localStorage.getItem(k) || ''; window.localStorage.setItem(k, v); } catch (e) { /* private mode */ } return ''; }
    var visitor = keep('lookon_vid');
    if (!visitor) { visitor = (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40); keep('lookon_vid', visitor); }
    var shopperEmail = keep('lookon_email');
    var customer = { id: root.dataset.customerId || '', email: root.dataset.customerEmail || '' };
    function whoParams() { return { visitor: visitor, email: shopperEmail, customerId: customer.id, customerEmail: customer.email }; }

    var info = null;        // what the server says about this product
    var tx = makeTx(function () { return info && info.texts; });
    // Wording priority: changed in the lookOn app > set in the theme editor (data-theme-text) > lookOn default.
    function applyTexts() {
      var custom = (info && info.textsCustom) || [];
      root.querySelectorAll('[data-t]').forEach(function (n) {
        var key = n.getAttribute('data-t');
        if (n.hasAttribute('data-theme-text') && custom.indexOf(key) < 0) return;
        var v = tx(key, { category: info && info.category ? info.category.label : '' });
        if (n.getAttribute('data-t-attr')) n.setAttribute(n.getAttribute('data-t-attr'), v); else n.textContent = v;
        if (n === hintEl) n.hidden = !v;
      });
    }
    var watchTimer = null, mountTimer = null, mountObserver = null;

    // The app block (placement "manual") stays exactly where the merchant put it in the theme editor.
    // The app embed (placement "auto") renders at the end of <body>; the script moves it to the chosen position
    // (above/below Add to cart, below Buy it now, end of product information) and puts it back if the theme re-renders.
    var autoPlace = root.dataset.placement === 'auto';
    var position = root.dataset.position || 'before_cart';
    function mountNearProductForm() {
      if (!autoPlace) return true;
      if (typeof document === 'undefined' || !document || !document.querySelector) return false; // page torn down
      var form = document.querySelector('form[action*="/cart/add"], product-form form, [data-type="add-to-cart-form"]');
      var info = document.querySelector('.product__info-wrapper, .product__info-container, .product-information, .product-single__meta, .product__info, [class*="product-info"]');
      var anchor = null, where = 'before';
      if (position === 'info_end' && info) { anchor = info; where = 'append'; }
      else if (form) {
        anchor = form; where = position === 'before_cart' ? 'before' : 'after';
        if (position === 'after_buttons') {
          var box = form.closest('.product-form__buttons, product-form, .product-form') || form;
          var more = box.parentNode && box.parentNode.querySelector('.shopify-payment-button, [data-shopify="payment-button"]');
          anchor = more && !box.contains(more) ? more : box;
        }
      } else if (info) { anchor = info; where = 'append'; }
      else anchor = document.querySelector('main'), where = 'append';
      if (!anchor || anchor === root || root.contains(anchor)) return false;
      if (where === 'append') { if (root.parentNode !== anchor) anchor.appendChild(root); }
      else if (where === 'before') { if (root.nextElementSibling !== anchor) anchor.parentNode.insertBefore(root, anchor); }
      else if (root.previousElementSibling !== anchor) anchor.parentNode.insertBefore(root, anchor.nextSibling);
      root.dataset.mounted = '1';
      return true;
    }
    // Not a product page (no handle): nothing to show. On a product page the block shows at once while the server
    // decides whether this product can be tried on.
    root.hidden = !(shop && handle);
    if (shop && handle && autoPlace) {
      mountNearProductForm();
      if (window.MutationObserver) {
        mountObserver = new MutationObserver(function () { mountNearProductForm(); });
        mountObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
      }
      mountTimer = setInterval(mountNearProductForm, 1000);
    }
    var photoUrl = null;    // the shopper's own photo (data URL) for the compare toggle
    var small = null;       // the photo as sent to the AI
    var hi = null, LP = null;  // the shopper's photo at face-quality size, and its face landmarks
    var resultUrl = null, mergedUrl = null, shownOriginal = false, lastVariant = null, busy = false, camStream = null;

    // ---- which variant is selected? (the shopper can change it at any time) ----
    function currentVariant() {
      var p = new URLSearchParams(location.search).get('variant');
      if (p) return p;
      var f = document.querySelector('form[action*="/cart/add"] [name="id"]');
      return (f && f.value) || root.dataset.variant || '';
    }

    function setBusy(b) { busy = b; root.classList.toggle('ptn-busy', b); }

    // ---- scanner over the shopper's photo (while the photo is checked and while the preview is made) ----
    var scanStep = el(root, '.ptn-scan-step'), scanBar = el(root, '.ptn-scan-bar > span'), scanRing = el(root, '.ptn-scan-ring');
    var errBox = el(root, '.ptn-alert'), errTitle = el(root, '.ptn-alert-title'), errMsg = el(root, '.ptn-alert-msg');
    var retryBtn = el(root, '.ptn-retry'), newPhotoBtn = el(root, '.ptn-newphoto');
    var scanTimer = null, scanT0 = 0, scanKey = '', scanProduct = '';
    var SCAN_STEPS = [[0, 'scanPhoto'], [3500, 'scanFit'], [10000, 'scanPlace'], [22000, 'scanFinish'], [40000, 'scanAlmost']];
    function setStep(key) {
      if (!scanStep || key === scanKey) return;
      scanKey = key;
      var text = tx(key, { product: scanProduct });
      scanStep.classList.add('ptn-swap');
      setTimeout(function () { scanStep.textContent = text; scanStep.classList.remove('ptn-swap'); }, 180);
    }
    function setBar(pct) {
      var v = Math.max(0, Math.min(100, pct)).toFixed(1);
      if (scanBar) scanBar.style.width = v + '%';
      if (scanRing) scanRing.style.setProperty('--p', v);
    }
    function startScan(phase) {
      if (scanTimer) clearInterval(scanTimer);
      showImage(photoUrl);
      stage.hidden = false;
      root.classList.add('ptn-scanning');
      scanT0 = Date.now(); scanKey = '';
      scanProduct = (info && info.title) || (info && info.category && info.category.label) || '';
      if (phase === 'check') { setStep('scanPhoto'); setBar(8); return; }
      setBar(12);
      var tick = function () {
        var t = Date.now() - scanT0, key = SCAN_STEPS[0][1];
        for (var i = 0; i < SCAN_STEPS.length; i++) if (t >= SCAN_STEPS[i][0]) key = SCAN_STEPS[i][1];
        setStep(key);
        setBar(12 + 83 * (1 - Math.exp(-t / 18000))); // eases towards 95% and never claims to be done early
      };
      tick();
      scanTimer = setInterval(tick, 500);
    }
    function stopScan(done) {
      if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
      if (!done) { root.classList.remove('ptn-scanning'); setBar(0); return; }
      setBar(100);
      setTimeout(function () { root.classList.remove('ptn-scanning'); setBar(0); }, 350);
    }

    // ---- errors: plain words, a way forward, and never any technical or provider detail ----
    var TECH = /gemini|google|vertex|openai|gpt|cloudflare|flux|replicate|nano.?banana|imagen|api[ -]?key|token|model|quota|failed to fetch|networkerror|load failed|json|undefined|null|stack|\bat \w/i;
    // Returns [message, kind]. kind picks the title: photo, offline, busy, paused or error.
    function friendly(code, status, message) {
      if (code === 'no_credit' || status === 402) return [tx('outOfCredits'), 'paused'];
      if (code === 'limit' && message && !TECH.test(message)) return [message, 'busy']; // "wait a minute" or "today's limit reached"
      if (code === 'busy' || status === 429) return [tx('busy'), 'busy'];
      if (code === 'timeout' || status === 504 || status === 408) return [tx('timeout'), 'error'];
      if (code === 'too_large' || status === 413) return [tx('photoTooLarge'), 'photo'];
      if (code === 'unavailable' || status === 503) return [tx('unavailable'), 'paused'];
      if (message && !TECH.test(message) && (code === 'photo' || status === 422)) return [message, 'photo'];
      if (message && !TECH.test(message) && (code === 'not_found' || code === 'not_allowed' || status === 404 || status === 403)) return [message, 'error'];
      return [tx('genericError'), 'error'];
    }
    var TITLES = { photo: 'photoTitle', offline: 'offlineTitle', busy: 'busyTitle', paused: 'pausedTitle', error: 'errorTitle' };
    function showError(message, canRetry, kind) {
      kind = kind || 'error';
      say('');
      if (!errBox) { say(message); return; }
      errTitle.textContent = tx(TITLES[kind] || 'errorTitle');
      errMsg.textContent = message;
      errBox.classList.toggle('ptn-alert-soft', kind === 'paused' || kind === 'busy' || kind === 'offline');
      errBox.hidden = false;
      if (retryBtn) retryBtn.hidden = !(canRetry && small);
      if (newPhotoBtn) newPhotoBtn.hidden = kind === 'paused' && !canRetry;
    }
    function clearError() {
      if (errBox) errBox.hidden = true;
      if (anyway) anyway.hidden = true;
    }

    // ---- the merchant's shopper rules: free try-ons, then email or sign-in; per-product and daily limits ----
    var gateEl = el(root, '.ptn-gate'), gateForm = el(root, '.ptn-gate-form'), gateEmail = el(root, '.ptn-gate-email'), gateErr = el(root, '.ptn-gate-err');
    var gateLogin = el(root, '.ptn-gate-login'), gateOr = el(root, '.ptn-gate-or'), gateMkt = el(root, '.ptn-gate-mkt'), leftEl = el(root, '.ptn-left');
    function renderAccess(a) {
      if (!gateEl) return;
      a = a || {};
      var needs = Boolean(a.needsIdentity);
      gateEl.hidden = !needs;
      root.classList.toggle('ptn-gated', needs);
      if (needs) {
        el(root, '.ptn-gate-intro').textContent = tx(a.gate === 'login' ? 'gateLoginIntro' : a.gate === 'email' ? 'gateEmailIntro' : 'gateEitherIntro');
        gateForm.hidden = a.gate === 'login';
        gateLogin.hidden = a.gate === 'email';
        gateOr.hidden = a.gate !== 'either';
        if (gateMkt) gateMkt.hidden = !a.askMarketing;
        var back = location.pathname + location.search;
        gateLogin.href = (root.dataset.loginUrl || '/account/login') + '?return_url=' + encodeURIComponent(back);
      }
      var left = '';
      if (!needs && a.freeLeft !== null && a.freeLeft !== undefined && a.freeLeft > 0) left = tx('freeLeft', { count: a.freeLeft });
      else if (!needs && a.productLeft !== null && a.productLeft !== undefined && a.productLeft > 0) left = tx('productLeft', { count: a.productLeft });
      if (leftEl) { leftEl.textContent = left; leftEl.hidden = !left; }
      if (!needs && (a.productLeft === 0 || a.todayLeft === 0)) showError(tx(a.productLeft === 0 ? 'limitProduct' : 'limitDay'), false, 'busy');
    }
    function refreshAccess() { loadInfo().then(function (j) { if (j && j.access) { info.access = j.access; renderAccess(j.access); } }).catch(function () {}); }
    if (gateForm) gateForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var email = String(gateEmail.value || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { gateErr.textContent = tx('gateEmailInvalid'); gateEmail.focus(); return; }
      gateErr.textContent = '';
      var btn = gateForm.querySelector('button'); btn.disabled = true;
      fetch(api + '/api/shopper', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shop: shop, handle: handle, visitor: visitor, email: email, marketing: Boolean(el(root, '.ptn-gate-mkt-box') && el(root, '.ptn-gate-mkt-box').checked) }) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (x) {
          btn.disabled = false;
          if (!x.ok) { gateErr.textContent = x.j.code === 'email' ? tx('gateEmailInvalid') : tx('genericError'); return; }
          shopperEmail = x.j.email; keep('lookon_email', shopperEmail);
          info.access = x.j.access; renderAccess(x.j.access); clearError();
          say(tx('gateThanks'));
        })
        .catch(function () { btn.disabled = false; gateErr.textContent = tx('networkError'); });
    });
    if (retryBtn) retryBtn.addEventListener('click', function () { clearError(); run(); });
    if (newPhotoBtn) newPhotoBtn.addEventListener('click', function () { clearError(); var f = el(root, '.ptn-file'); if (f) f.click(); });
    function say(t) { status.textContent = t || ''; }

    // ---- ask the server what this product is (category, supported or not) ----
    function loadInfo() {
      var q = new URLSearchParams({ shop: shop, handle: handle, variant: currentVariant() });
      var w = whoParams(); for (var k in w) if (w[k]) q.set(k, w[k]);
      if (hint) q.set('category', hint);
      return fetch(api + '/api/product?' + q).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); }).then(function (x) {
        if (!x.ok) throw new Error(x.j && x.j.error || 'The try-on is not available right now.');
        return x.j;
      });
    }

    function boot() {
      // An app embed is rendered on every page. Do not leave a product page
      // looking empty while the product lookup is in flight; hide it again
      // only after the API confirms that the current product is not tryable.
      if (shop && handle) root.hidden = false;
      loadInfo().then(function (j) {
        info = j;
        if (!j.tryable) {
          // Do not silently hide a classified product when only the AI engine
          // is unavailable. Show the block and its status instead.
          applyTexts();
          if (j.category) { root.hidden = false; if (j.reason) say(j.reason); root.classList.toggle('ptn-off', Boolean(j.outOfCredits)); }
          else root.hidden = true;
          if (window.Shopify && window.Shopify.designMode) { root.hidden = false; say('Theme editor note: ' + (j.reason || 'this product cannot be tried on.') + ' (Set the product metafield custom.tryon_category to force a category.)'); }
          root.dataset.state = j.category ? 'off' : 'hidden';
          return; // not a wearable: show nothing to shoppers
        }
        applyTexts();
        renderAccess(j.access);
        root.hidden = false;
        root.dataset.state = 'ready';
      }).catch(function (e) {
        // Keep the block visible with an actionable status instead of hiding
        // every integration error. This also makes store/token/sync problems
        // diagnosable from the storefront.
        root.dataset.state = 'error';
        if (shop && handle) { root.hidden = false; say(tx('unavailable')); }
        if (window.Shopify && window.Shopify.designMode) say('Theme editor note: ' + e.message);
      });
    }

    // ---- photo handling ----
    // Halve repeatedly with high-quality smoothing, so eyes and hairline stay sharp in the smaller copy.
    function downscale(src, tw, th) {
      var cur = src, cw = src.width, ch = src.height;
      while (cw / 2 >= tw && ch / 2 >= th) {
        var nw = Math.round(cw / 2), nh = Math.round(ch / 2);
        var t = document.createElement('canvas'); t.width = nw; t.height = nh;
        var tx = t.getContext('2d'); tx.imageSmoothingQuality = 'high'; tx.drawImage(cur, 0, 0, nw, nh);
        cur = t; cw = nw; ch = nh;
      }
      var out = document.createElement('canvas'); out.width = tw; out.height = th;
      var ox = out.getContext('2d'); ox.imageSmoothingQuality = 'high'; ox.drawImage(cur, 0, 0, tw, th);
      return out;
    }

    function readPhoto(file, maxSide) {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (bmp) {
        var full = document.createElement('canvas'); full.width = bmp.width; full.height = bmp.height;
        full.getContext('2d').drawImage(bmp, 0, 0); // re-encoding also strips EXIF / location data
        var sized = function (side) {
          var k = Math.min(1, side / Math.max(bmp.width, bmp.height));
          var w = Math.max(64, Math.round(bmp.width * k)), h = Math.max(64, Math.round(bmp.height * k));
          return k < 1 ? downscale(full, w, h) : full;
        };
        var c = sized(maxSide), hiC = sized(HI_SIDE);
        var url = c.toDataURL('image/jpeg', 0.95);
        return { url: hiC.toDataURL('image/jpeg', 0.92), hi: hiC, payload: { mime: 'image/jpeg', data: url.split(',')[1], width: c.width, height: c.height } };
      });
    }

    function showImage(url) { result.src = url; }

    function run() {
      if (busy || !small || !info) return;
      var variant = currentVariant();
      clearError();
      if (typeof navigator !== 'undefined' && navigator.onLine === false) { showError(tx('networkError'), true, 'offline'); return; }
      setBusy(true);
      shownOriginal = false;
      startScan('make');
      root.classList.add('ptn-generating');
      regen.hidden = true;
      say(tx('generating'));
      // Small items with a face found: send a close-up of just that area (see pasteFocus).
      var focus = (info.focus && LP && hi) ? info.focus : null, rect = null, sendImg = small;
      if (focus) {
        try {
          rect = focusRect(focus, LP, hi.width, hi.height);
          if (rect.side < 32) throw new Error('too small');
          sendImg = cropPayload(hi, rect, Math.min(info.maxPersonSide || 480, 1024));
        } catch (e) { focus = null; rect = null; sendImg = small; }
      }
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var killer = ctrl ? setTimeout(function () { ctrl.abort(); }, 150000) : null;
      var failed = function (msg, retry, kind) { var e = new Error(msg); e.friendly = true; e.retry = retry !== false; e.kind = kind || 'error'; return e; };
      fetch(api + '/api/tryon', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl ? ctrl.signal : undefined,
        body: JSON.stringify({ shop: shop, handle: handle, variantId: variant, image: sendImg, consent: true, category: hint || undefined, focus: focus || undefined, visitor: visitor, email: shopperEmail || undefined, customer: customer.id ? customer : undefined }),
      }).catch(function (err) {
        throw err && err.name === 'AbortError' ? failed(tx('timeout')) : failed(tx('networkError'), true, 'offline');
      }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, j: j || {} }; }); })
        .then(function (x) {
          if (killer) clearTimeout(killer);
          if (!x.ok) {
            if (x.j.code === 'identify') { var gated = new Error('identify'); gated.identify = true; throw gated; }
            if (x.status === 402 || x.j.code === 'no_credit') { info.outOfCredits = true; root.classList.add('ptn-off'); }
            var fr = friendly(x.j.code, x.status, x.j.error);
            throw failed(fr[0], x.status !== 402 && x.status !== 403, fr[1]);
          }
          if (!x.j.image || !x.j.image.data) throw failed(tx('genericError'));
          resultUrl = 'data:' + x.j.image.mime + ';base64,' + x.j.image.data;
          lastVariant = variant;
          shownOriginal = false;
          toggle.textContent = tx('showOriginal');
          mergedUrl = null;
          if (focus && x.j.focus === focus) {
            var aiUrl = resultUrl;
            return loadImg(aiUrl).then(function (aiImg) {
              var r = pasteFocus(hi, rect, aiImg, focusMask(focus, LP, hi.width, hi.height));
              resultUrl = r.canvas.toDataURL('image/jpeg', 0.95);
              keepWrap.hidden = true;
              render();
              stage.hidden = false;
              var what = x.j.label || 'this product';
              if (!r.changed) say(tx('resultFocusMissed', { product: what }));
              else say(tx('resultFocus', { product: what, area: focus === 'nose' ? 'nose pin' : focus === 'neck' ? 'necklace' : focus === 'ears' ? 'earrings' : 'jewellery' }));
            });
          }
          var wantFace = Boolean(info.keepFace && x.j.keepFace !== false && LP && hi);
          return (wantFace ? finishWithFace(resultUrl) : Promise.resolve(false)).then(function (merged) {
            keepWrap.hidden = !wantFace;
            render();
            stage.hidden = false;
            var what = x.j.label || 'this product';
            if (merged) say(tx('resultFaceKept', { product: what }));
            else if (info.keepFace && x.j.keepFace !== false && !LP) say(tx('resultFaceMissing', { product: what }));
            else if (wantFace) say(tx('resultFaceNotAligned', { product: what }));
            else say(tx('resultDone', { product: what }));
          });
        })
        .then(function () { stopScan(true); refreshAccess(); }, function (e) {
          if (killer) clearTimeout(killer);
          stopScan(false);
          if (e && e.identify) { if (!resultUrl) stage.hidden = true; else render(); info.access = Object.assign({}, info.access, { needsIdentity: true }); renderAccess(info.access); return; }
          showError(e && e.friendly ? e.message : tx('genericError'), !(e && e.retry === false), e && e.kind);
          if (resultUrl) render();
          else stage.hidden = true;
        })
        .then(function () { root.classList.remove('ptn-generating'); setBusy(false); });
    }

    function render() { showImage(shownOriginal ? photoUrl : (keepBox.checked && mergedUrl) ? mergedUrl : resultUrl); }

    // Find the face in the AI picture, and if it lines up with the real one, build the version with the real face kept.
    function finishWithFace(aiUrl) {
      return loadImg(aiUrl).then(function (aiImg) {
        var a = document.createElement('canvas'); a.width = aiImg.naturalWidth; a.height = aiImg.naturalHeight;
        a.getContext('2d').drawImage(aiImg, 0, 0);
        return detectFace(a).then(function (LA) {
          if (!LA) return false;
          var m;
          try { m = mergeFace(hi, aiImg, LP, LA); } catch (e) { m = null; }
          if (!m) return false;
          mergedUrl = m.toDataURL('image/jpeg', 0.95);
          return true;
        });
      }).catch(function () { return false; });
    }

    function loadFile(file) {
      if (!file) return;
      if (info && info.outOfCredits) { say(tx('outOfCredits')); return; }
      if (!consent.checked) { say(tx('consentRequired')); return; }
      if (!info) { say(tx('stillLoading')); return; }
      if (busy) return;
      clearError();
      if (file.size && file.size > 25 * 1024 * 1024) { showError(tx('photoTooLarge'), false, 'photo'); return; }
      say(tx('loadingPhoto'));
      if (anyway) anyway.hidden = true;
      readPhoto(file, info.maxPersonSide || 480).then(function (p) {
        small = p.payload; photoUrl = p.url; hi = p.hi; LP = null;
        say(tx('checkingPhoto'));
        startScan('check');
        return checkPhoto(info.needs || 'face', hi, tx).then(function (r) {
          if (r.face) LP = r.face;
          if (r.ok) return true;
          stopScan(false);
          if (!resultUrl) stage.hidden = true; else render();
          showError(r.msg, false, 'photo');  // no AI call is spent on a photo that cannot work...
          if (anyway) anyway.hidden = false; // ...but the shopper can still go ahead if the checker got it wrong
          return false;
        });
      }).then(function (go) { if (go) run(); }).catch(function () { stopScan(false); if (!resultUrl) stage.hidden = true; showError(tx('photoUnreadable'), false, 'photo'); });
    }

    root.querySelectorAll('.ptn-file').forEach(function (inp) {
      inp.addEventListener('change', function () { loadFile(inp.files && inp.files[0]); inp.value = ''; });
    });

    // ---- selfie camera ----
    function stopCam() {
      if (camStream) { camStream.getTracks().forEach(function (t) { t.stop(); }); camStream = null; }
      if (video) video.srcObject = null;
      if (cam) cam.hidden = true;
    }
    selfieBtn.addEventListener('click', function () {
      if (!consent.checked) { say(tx('consentRequired')); return; }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { selfieFile.click(); return; }
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false }).then(function (s) {
        camStream = s; video.srcObject = s; cam.hidden = false;
        var pr = video.play && video.play(); if (pr && pr.catch) pr.catch(function () {});
        say(tx('cameraPrompt'));
      }).catch(function () { camStream = null; say(tx('cameraUnavailable')); });
    });
    snap.addEventListener('click', function () {
      var w = video.videoWidth, h = video.videoHeight;
      if (!w || !h) { say(tx('cameraStarting')); return; }
      var c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(video, 0, 0, w, h);
      stopCam();
      c.toBlob(function (b) { if (b) loadFile(b); }, 'image/jpeg', 0.95);
    });
    camClose.addEventListener('click', function () { stopCam(); say(''); });
    window.addEventListener('pagehide', function () {
      stopCam();
      if (scanTimer) clearInterval(scanTimer);
      if (watchTimer) clearInterval(watchTimer);
      if (mountTimer) clearInterval(mountTimer);
      if (mountObserver) mountObserver.disconnect();
    });

    // ---- result controls ----
    toggle.addEventListener('click', function () {
      shownOriginal = !shownOriginal;
      render();
      toggle.textContent = shownOriginal ? tx('showPreview') : tx('showOriginal');
    });
    regen.addEventListener('click', run);
    if (anyway) anyway.addEventListener('click', function () { anyway.hidden = true; clearError(); run(); });
    keepBox.addEventListener('change', function () { shownOriginal = false; toggle.textContent = tx('showOriginal'); render(); });
    download.addEventListener('click', function () {
      var a = document.createElement('a');
      a.href = (keepBox.checked && mergedUrl) ? mergedUrl : resultUrl; a.download = 'tryon-preview.jpg';
      document.body.appendChild(a); a.click(); a.remove();
    });

    // When the shopper picks another colour/size after a preview, offer a new preview (each one costs an AI call, so it is not automatic).
    watchTimer = setInterval(function () {
      if (busy || !resultUrl) return;
      var changed = currentVariant() !== lastVariant;
      if (regen.hidden === changed) regen.hidden = !changed;
    }, 600);

    boot();
  }

  function bootAll() {
    var all = Array.prototype.slice.call(document.querySelectorAll('.ptn'));
    // If the merchant placed the app block, the automatic embed steps aside so the try-on shows only once.
    var manual = all.some(function (r) { return r.dataset.placement === 'manual'; });
    all.forEach(function (r) {
      if (manual && r.dataset.placement === 'auto') { if (r.parentNode) r.parentNode.removeChild(r); return; }
      r.setAttribute('data-ptn-version', '2.2-blocks'); init(r);
    });
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootAll); else bootAll();
    document.addEventListener('shopify:section:load', bootAll);
  }
})();
