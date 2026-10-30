/* One-click "Convert to task" button (ExecuteFunction). */
function taniaNotify(type, text){
  try{
    var item = Office.context.mailbox.item; if(!item) return;
    var T = Office.MailboxEnums.ItemNotificationMessageType;
    var msg = { type: type === "progress" ? T.ProgressIndicator : (type === "error" ? T.ErrorMessage : T.InformationalMessage), message: String(text).slice(0, 150) };
    if(msg.type === T.InformationalMessage){ msg.icon = "Icon.16"; msg.persistent = false; }
    item.notificationMessages.replaceAsync("tania", msg);
  }catch(e){}
}
function quickTask(event){
  var finish = function(){ try{ event.completed(); }catch(e){} };
  taniaNotify("progress", "جارٍ تحويل الرسالة إلى مهمة في منصة تانيا…");
  TOL.send({}).then(function(r){
    if(r.dup){
      taniaNotify("info", r.processed ? "هذه الرسالة محوّلة سابقًا إلى مهمة في المنصة." : "الرسالة في قائمة الانتظار — ستظهر كمهمة فور فتح المنصة.");
      finish(); return;
    }
    taniaNotify("info", "✓ أُرسلت إلى المنصة — جارٍ إنشاء المهمة…");
    TOL.waitProcessed(r.docId, 9000).then(function(tid){
      taniaNotify("info", tid ? "✓ تم إنشاء المهمة في منصة تانيا ومُسندة إليك." : "✓ أُرسلت — ستظهر كمهمة فور فتح المنصة على أي جهاز.");
      finish();
    });
  }).catch(function(e){ taniaNotify("error", "تعذّر التحويل: " + TOL.errText(e)); finish(); });
}
Office.onReady(function(){
  try{ if(Office.actions && Office.actions.associate) Office.actions.associate("quickTask", quickTask); }catch(e){}
});
/* Older hosts look up the function on the global object */
window.quickTask = quickTask;
