/* WH Taska service worker — يُرفع بجانب index.html */
self.addEventListener('install',function(e){ self.skipWaiting(); });
self.addEventListener('activate',function(e){ e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch',function(e){});
self.addEventListener('push',function(e){
  var d={}; try{ d=e.data?e.data.json():{}; }catch(x){ d={title:'WH Taska',body:e.data&&e.data.text()}; }
  var n=d.notification||d;
  e.waitUntil(self.registration.showNotification(n.title||'مهمة جديدة',{
    body:n.body||'',icon:'icon-192.png',badge:'icon-192.png',tag:d.tag||('t'+(d.taskId||Date.now())),renotify:true,
    vibrate:[250,120,250,120,450],requireInteraction:true,dir:'rtl',lang:'ar',data:{taskId:d.taskId||(d.data&&d.data.taskId)||null}}));
});
self.addEventListener('notificationclick',function(e){
  e.notification.close(); var id=e.notification.data&&e.notification.data.taskId;
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(function(cs){
    for(var i=0;i<cs.length;i++){ if('focus' in cs[i]){ cs[i].postMessage({type:'ntf-click',taskId:id}); return cs[i].focus(); } }
    return self.clients.openWindow('./');
  }));
});
