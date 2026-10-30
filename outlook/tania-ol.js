/* Tania — Outlook add-in core (shared by the one-click button and the task pane).
   Sends the selected email to the platform's existing Outlook inbox queue (Firestore "tania_db_inbox").
   The platform converts every queued email into a task automatically — no Microsoft app registration,
   no Graph permissions, no extra accounts. */
var TOL = (function(){
  var CFG = { apiKey: "AIzaSyAO6WZmGyw4dmp18U6yqy1WCXYjD9r5zkg", authDomain: "taniatask-866cc.firebaseapp.com", projectId: "taniatask-866cc" };
  var PLATFORM = "https://wh-tsaks.pages.dev/";
  var ready = null, db = null;

  function init(){
    if(ready) return ready;
    ready = new Promise(function(res, rej){
      try{
        if(typeof firebase === "undefined") throw new Error("sdk");
        if(!firebase.apps.length) firebase.initializeApp(CFG);
        db = firebase.firestore();
        var auth = firebase.auth();
        (auth.currentUser ? Promise.resolve() : auth.signInAnonymously()).then(function(){ res(db); }, rej);
      }catch(e){ rej(e); }
    });
    ready.catch(function(){ ready = null; });
    return ready;
  }
  function timeout(p, ms, msg){ return Promise.race([p, new Promise(function(_, r){ setTimeout(function(){ r(new Error(msg || "timeout")); }, ms); })]); }
  /* cyrb53 — short stable id from the message id */
  function hash(str){ var h1=0xdeadbeef, h2=0x41c6ce57; for(var i=0,ch;i<str.length;i++){ ch=str.charCodeAt(i); h1=Math.imul(h1^ch,2654435761); h2=Math.imul(h2^ch,1597334677); }
    h1=Math.imul(h1^(h1>>>16),2246822507)^Math.imul(h2^(h2>>>13),3266489909); h2=Math.imul(h2^(h2>>>16),2246822507)^Math.imul(h1^(h1>>>13),3266489909);
    return (h2>>>0).toString(36)+(h1>>>0).toString(36); }
  function getBody(item){ return new Promise(function(res){ try{ item.body.getAsync(Office.CoercionType.Text, function(r){ res(r && r.status === Office.AsyncResultStatus.Succeeded ? (r.value || "") : ""); }); }catch(e){ res(""); } }); }
  function webLink(item){
    try{
      if(!item.itemId || !Office.context.mailbox.convertToRestId) return "";
      var id = Office.context.mailbox.convertToRestId(item.itemId, Office.MailboxEnums.RestVersion.v2_0);
      return "https://outlook.office.com/mail/deeplink/read/" + encodeURIComponent(id);
    }catch(e){ return ""; }
  }
  function me(){ var p = Office.context.mailbox.userProfile || {}; return { email: String(p.emailAddress || "").toLowerCase(), name: p.displayName || "" }; }
  function msgKey(item){ return (item.internetMessageId || item.itemId || (item.subject + "|" + (item.dateTimeCreated || ""))) + "|" + me().email; }
  function docId(item){ return "ol_" + hash(msgKey(item)); }

  async function collect(item){
    var text = await getBody(item);
    text = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
    var atts = (item.attachments || []).filter(function(a){ return !a.isInline; }).map(function(a){ return { name: a.name, size: a.size || 0, contentType: a.contentType || "" }; });
    var body = text.slice(0, 6000) + (text.length > 6000 ? "\n…" : "");
    if(atts.length) body += "\n\n📎 المرفقات في البريد الأصلي: " + atts.map(function(a){ return a.name; }).join("، ");
    var from = item.from || item.sender || {};
    return {
      subject: String(item.subject || "").trim(),
      fromEmail: String(from.emailAddress || "").toLowerCase(),
      fromName: from.displayName || "",
      toEmail: (item.to || []).map(function(x){ return x.emailAddress; }).join(", "),
      receivedAt: item.dateTimeCreated ? new Date(item.dateTimeCreated).toISOString() : "",
      body: body,
      attachments: atts,
      webLink: webLink(item)
    };
  }

  /* opts: { title, priority, deadline (YYYY-MM-DD), assignToEmails [], note, force } */
  async function send(opts){
    opts = opts || {};
    var item = Office.context.mailbox.item; if(!item) throw new Error("noitem");
    var m = await collect(item), u = me();
    await timeout(init(), 15000, "connect");
    var ref = db.collection("tania_db_inbox").doc(docId(item));
    if(!opts.force){
      var snap = await timeout(ref.get(), 15000, "connect");
      if(snap.exists){ var d = snap.data() || {}; return { dup: true, processed: !!d.processed, taskId: d.taskId || null, docId: ref.id }; }
    }
    var payload = {
      processed: false, source: "outlook-addin", noCopy: true,
      messageId: msgKey(item) + (opts.force ? "|" + Date.now() : ""),
      subject: m.subject, fromEmail: m.fromEmail, fromName: m.fromName, toEmail: m.toEmail, receivedAt: m.receivedAt,
      body: m.body, attachments: m.attachments, webLink: m.webLink,
      ownerEmail: u.email, ownerName: u.name,
      assignToEmails: (opts.assignToEmails && opts.assignToEmails.length) ? opts.assignToEmails : [u.email],
      priority: opts.priority || "medium", deadline: opts.deadline || "", title: opts.title || "", note: opts.note || "",
      createdAt: new Date().toISOString()
    };
    await timeout(ref.set(payload), 20000, "connect");
    return { ok: true, docId: ref.id };
  }
  /* Resolves with the created task id once a platform client has processed the email (or null on timeout). */
  function waitProcessed(id, ms){
    return new Promise(function(res){
      var done = false, unsub = null;
      var fin = function(v){ if(done) return; done = true; try{ unsub && unsub(); }catch(e){} res(v); };
      setTimeout(function(){ fin(null); }, ms || 8000);
      init().then(function(){ unsub = db.collection("tania_db_inbox").doc(id).onSnapshot(function(s){ var d = s.data() || {}; if(d.processed) fin(d.taskId || true); }, function(){ fin(null); }); }, function(){ fin(null); });
    });
  }
  /* Platform users (for the assignee picker). */
  async function users(){
    await timeout(init(), 15000, "connect");
    var s = await timeout(db.collection("tania_db").doc("main").get(), 20000, "connect");
    var list = ((s.exists && s.data().users) || []).filter(function(x){ return x && x.email && !x.frozen; })
      .map(function(x){ return { id: x.id, name: x.name || x.email, email: String(x.email).toLowerCase(), role: x.role || "" }; });
    list.sort(function(a, b){ return a.name.localeCompare(b.name, "ar"); });
    return list;
  }
  function errText(e){
    var m = String((e && (e.code || e.message)) || e || "");
    if(/permission/i.test(m)) return "قواعد Firebase تمنع الكتابة في صندوق Outlook (tania_db_inbox)";
    if(/connect|timeout|unavailable|network|offline/i.test(m)) return "تعذّر الاتصال بالمنصة — تحقق من الإنترنت";
    if(/admin-restricted|operation-not-allowed/i.test(m)) return "الدخول المجهول معطّل في Firebase";
    if(/sdk/.test(m)) return "تعذّر تحميل مكتبة Firebase";
    return m || "خطأ غير معروف";
  }
  return { init: init, send: send, waitProcessed: waitProcessed, users: users, me: me, errText: errText, docId: docId, PLATFORM: PLATFORM };
})();
