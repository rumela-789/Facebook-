// Server-side adult-image moderation for Vimline (cannot be bypassed from the client).
const { onDocumentWritten, onDocumentCreated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const vision = require("@google-cloud/vision");

initializeApp();
const db = getFirestore();
const vc = new vision.ImageAnnotatorClient();

// IMPORTANT: set this to the same region as your Firestore database
const REGION = "asia-southeast1";
const LV = { UNKNOWN: 0, VERY_UNLIKELY: 1, UNLIKELY: 2, POSSIBLE: 3, LIKELY: 4, VERY_LIKELY: 5 };

const isBad = (a) => (LV[a.adult] || 0) >= LV.LIKELY || (LV[a.racy] || 0) >= LV.VERY_LIKELY;

async function unpublish(id, uid) {
  const p = db.doc("posts/" + id);
  if ((await p.get()).exists) {
    await p.update({ flagged: true, flagWhy: "adult", flagUntil: FieldValue.delete() });
  }
  const c = db.doc("comments/" + id);
  if ((await c.get()).exists) await c.delete();
  if (uid) {
    await db.doc("msgs/bot_" + id).set({
      from: "vimline_bot", to: uid, members: ["vimline_bot", uid],
      text: "Your photo contained adult (18+) content. It was removed and the post is unpublished. Please delete it.",
      fname: "Vimline Bot", ts: Date.now(),
    });
  }
}

// 1) Every image write is scanned. Bad images are erased on the server immediately.
exports.scanImage = onDocumentWritten({ document: "imgs/{id}", region: REGION }, async (ev) => {
  const after = ev.data && ev.data.after;
  if (!after || !after.exists) return;
  const data = after.data();
  const d = data.d;
  if (!d || typeof d !== "string" || !d.startsWith("data:image")) return;
  let a = {};
  try {
    const [r] = await vc.safeSearchDetection({ image: { content: d.split(",")[1] } });
    a = r.safeSearchAnnotation || {};
  } catch (e) {
    console.error("vision failed", e);
    return;
  }
  if (!isBad(a)) return;
  const id = ev.params.id;
  await after.ref.set({ d: "", blocked: true, uid: data.uid || null });
  await db.doc("mod/" + id).set({ bad: true, uid: data.uid || null, ts: Date.now() });
  await unpublish(id, data.uid);
});

// 2) If the post is created after its image was already blocked, unpublish it too.
exports.checkPost = onDocumentCreated({ document: "posts/{id}", region: REGION }, async (ev) => {
  const p = ev.data && ev.data.data();
  if (!p || !p.hasImg) return;
  const m = await db.doc("mod/" + ev.params.id).get();
  if (m.exists && m.data().bad) {
    await ev.data.ref.update({ flagged: true, flagWhy: "adult", flagUntil: FieldValue.delete() });
  }
});

// 3) Adult / inappropriate services: scan text on every create/edit, unpublish on the server.
const ADULT_EN = /(^|[^a-z])(sex(?!olog)\w*|escorts?|call\s?girls?|prostitut\w*|hookers?|brothels?|nudes?|porn\w*|xxx|erotic\w*|hook\s?ups?|sugar\s?(daddy|mommy|mama)|happy\s?ending|hand\s?job|blow\s?job|nuru|body\s?to\s?body|adults?\s?only|adult\s?(service|content|video|chat)s?|18\s?\+)([^a-z]|$)/;
const ADULT_BN = ["সেক্স","যৌন সেবা","যৌনকর্মী","যৌন মিলন","পতিতা","বেশ্যা","কলগার্ল","কল গার্ল","এসকর্ট","নগ্ন","উলঙ্গ","পর্ন","১৮+","১৮ প্লাস"];
const adultText = (t) => {
  const x = String(t || "").toLowerCase().replace(/[\u200b-\u200d]/g, "").replace(/0/g, "o").replace(/1/g, "i")
    .replace(/3/g, "e").replace(/@/g, "a").replace(/\$/g, "s").replace(/[_\-.*]+/g, " ");
  return ADULT_EN.test(x) || ADULT_BN.some((w) => x.includes(w));
};

exports.checkService = onDocumentWritten({ document: "svc/{id}", region: REGION }, async (ev) => {
  const a = ev.data && ev.data.after;
  if (!a || !a.exists) return;
  const s = a.data();
  if (s.flagWhy === "adult") return;
  if (!adultText([s.cat, s.name, s.area, s.price, s.hours, s.qual, s.note].join(" "))) return;
  await a.ref.update({ pub: false, flagWhy: "adult" });
  if (s.uid) {
    await db.doc("msgs/bot_svc_" + ev.params.id).set({
      from: "vimline_bot", to: s.uid, members: ["vimline_bot", s.uid],
      text: "Your service was unpublished because it appears to offer adult (18+) or inappropriate content. Please delete it.",
      fname: "Vimline Bot", ts: Date.now(),
    });
  }
});
