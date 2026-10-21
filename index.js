// Vimline Cloud Functions
//  1. loginWithId   – username / phone / old Gmail login without exposing emails
//  2. turnCreds     – short-lived TURN credentials (Cloudflare Realtime, 1000 GB/month free) for audio/video calls
//  3. purgeDeleted  – permanently deletes accounts 15 days after the user asked for deletion
//  4. push triggers – FCM notifications for messages, comments, follows and incoming calls
const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");
const crypto = require("crypto");
admin.initializeApp();
const db = admin.firestore();
const KEY = process.env.WEB_API_KEY;

const normPhone = (s) => {
  let d = String(s || "").replace(/\D/g, "");
  if (d.startsWith("880") && d.length >= 12) d = "0" + d.slice(3);
  return d;
};

/* ---------- 1. login ---------- */
exports.loginWithId = functions.https.onCall(async (data) => {
  const id = String((data && data.id) || "").trim();
  const pw = String((data && data.password) || "");
  if (!id || id.length > 80 || pw.length < 6) return { email: "" };
  const key = crypto.createHash("sha256").update(id.toLowerCase()).digest("hex");
  const ref = db.collection("loginTries").doc(key);
  const now = Date.now();
  const snap = await ref.get();
  let st = snap.exists ? snap.data() : { n: 0, t: now };
  if (now - st.t > 15 * 60 * 1000) st = { n: 0, t: now };
  if (st.n >= 8) throw new functions.https.HttpsError("resource-exhausted", "Too many attempts");

  let uid = null;
  const low = id.toLowerCase();
  if (id.includes("@")) {
    let q = await db.collection("private").where("emailL", "==", low).limit(1).get();
    if (!q.empty) uid = q.docs[0].id;
    else {
      q = await db.collection("private").where("oldEmail", "==", low).limit(1).get();
      if (!q.empty && q.docs[0].data().oldUntil > now) uid = q.docs[0].id; // removed Gmail works 5 days
    }
  } else if (/[a-zA-Z]/.test(id)) {
    const q = await db.collection("profiles").where("usernameLower", "==", low.replace(/^@/, "")).limit(1).get();
    if (!q.empty) uid = q.docs[0].id;
  } else {
    const q = await db.collection("private").where("phoneN", "==", normPhone(id)).limit(1).get();
    if (!q.empty) uid = q.docs[0].id;
  }
  let email = "";
  if (uid) {
    try {
      const u = await admin.auth().getUser(uid);
      const r = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + KEY, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: u.email, password: pw, returnSecureToken: false }),
      });
      if (r.ok) email = u.email;
    } catch (e) {}
  }
  if (email) await ref.delete().catch(() => {});
  else await ref.set({ n: st.n + 1, t: st.t });
  return { email };
});

/* ---------- 2. TURN credentials ---------- */
exports.turnCreds = functions.https.onCall(async (data, ctx) => {
  if (!ctx.auth) throw new functions.https.HttpsError("unauthenticated", "Sign in first");
  const r = await fetch("https://rtc.live.cloudflare.com/v1/turn/keys/" + process.env.CF_TURN_KEY_ID + "/credentials/generate", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.CF_TURN_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl: 7200 }),
  });
  if (!r.ok) throw new functions.https.HttpsError("internal", "TURN unavailable");
  const j = await r.json();
  return { iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }, j.iceServers] };
});

/* ---------- 3. permanent deletion after 15 days ---------- */
async function delWhere(col, field, uid) {
  const s = await db.collection(col).where(field, "==", uid).get();
  await Promise.all(s.docs.map((d) => d.ref.delete().catch(() => {})));
}
async function purge(uid) {
  const ps = await db.collection("posts").where("uid", "==", uid).get();
  for (const d of ps.docs) {
    await db.collection("imgs").doc(d.id).delete().catch(() => {});
    await db.collection("voices").doc(d.id).delete().catch(() => {});
    await d.ref.delete().catch(() => {});
  }
  const list = [["comments","uid"],["likes","uid"],["cReacts","uid"],["pReacts","uid"],["svc","uid"],["rate","uid"],["saved","uid"],["pins","uid"],["shares","uid"],["follows","from"],["follows","to"],["blocks","from"],["blocks","to"],["gmsgs","from"],["msgs","from"],["calls","from"]];
  for (const [c, f] of list) await delWhere(c, f, uid);
  await db.collection("private").doc(uid).delete().catch(() => {});
  await db.collection("profiles").doc(uid).delete().catch(() => {});
  await admin.auth().deleteUser(uid).catch(() => {});
}
exports.purgeDeleted = functions.pubsub.schedule("every 24 hours").onRun(async () => {
  const s = await db.collection("profiles").where("deleting", "==", true).get();
  const now = Date.now();
  for (const d of s.docs) if ((d.data().delAt || 0) <= now) await purge(d.id);
  return null;
});

/* ---------- 4. push notifications ---------- */
async function nameOf(uid) {
  const s = await db.collection("profiles").doc(uid).get();
  return (s.exists && s.data().name) || "Someone";
}
async function push(uid, title, body, tag) {
  if (!uid) return;
  const ps = await db.collection("private").doc(uid).get();
  const tokens = (ps.exists && ps.data().fcm) || [];
  if (!tokens.length) return;
  const r = await admin.messaging().sendEachForMulticast({
    tokens, data: { title, body, tag: tag || "vimline", url: "./" },
    webpush: { headers: { Urgency: "high", TTL: "120" } }, android: { priority: "high" },
  });
  const bad = [];
  r.responses.forEach((x, i) => { if (!x.success && /registration-token|not-registered/.test((x.error && x.error.code) || "")) bad.push(tokens[i]); });
  if (bad.length) await db.collection("private").doc(uid).set({ fcm: admin.firestore.FieldValue.arrayRemove(...bad) }, { merge: true });
}
exports.onMsg = functions.firestore.document("msgs/{id}").onCreate(async (s) => {
  const m = s.data(); if (!m.to || m.from === "vimline_bot" || m.to === m.from) return;
  await push(m.to, await nameOf(m.from), "New message", "msg_" + m.from);   // content is end-to-end encrypted
});
exports.onComment = functions.firestore.document("comments/{id}").onCreate(async (s) => {
  const c = s.data(), n = await nameOf(c.uid);
  const p = await db.collection("posts").doc(c.postId).get();
  if (p.exists && p.data().uid !== c.uid) await push(p.data().uid, n, "commented on your post", "c_" + c.postId);
  if (c.parentId) {
    const pc = await db.collection("comments").doc(c.parentId).get();
    if (pc.exists && pc.data().uid !== c.uid && (!p.exists || pc.data().uid !== p.data().uid)) await push(pc.data().uid, n, "replied to your comment", "r_" + c.parentId);
  }
});
exports.onFollow = functions.firestore.document("follows/{id}").onCreate(async (s) => {
  const f = s.data(); if (f.to && f.to !== f.from) await push(f.to, await nameOf(f.from), "added you", "f_" + f.from);
});
exports.onCall = functions.firestore.document("calls/{id}").onCreate(async (s) => {
  const c = s.data(); if (c.status === "ringing" && c.to) await push(c.to, await nameOf(c.from), c.type === "video" ? "Incoming video call" : "Incoming audio call", "call");
});
