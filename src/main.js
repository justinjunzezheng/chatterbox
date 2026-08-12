import { createClient } from "@supabase/supabase-js";
import "./styles.css";
import "./extras.css";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
const root = document.querySelector("#app");

if (!url || !key) {
  root.innerHTML = `<main class="setup"><div class="logo">c</div><h1>Chatterbox needs connecting</h1><p>Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> in Vercel, then redeploy.</p></main>`;
} else {
  const supabase = createClient(url, key);
  start(supabase);
}

async function start(supabase) {
  let state = { session: null, profile: null, chats: [], active: null, messages: [], searchResults: [], channel: null, replyTo: null, blocked: new Set(), peer: null, localStream: null, callChannel: null };

  const escapeHtml = (value = "") => value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  const initials = (value = "?") => value.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  const time = (value) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const { data: { session } } = await supabase.auth.getSession();
  state.session = session;
  supabase.auth.onAuthStateChange((_event, nextSession) => { state.session = nextSession; boot(); });
  boot();

  async function boot() {
    if (!state.session) return renderSignIn();
    const { data } = await supabase.from("profiles").select("*").eq("id", state.session.user.id).single();
    state.profile = data;
    if (!data?.username) return renderOnboarding();
    const { data: blocks } = await supabase.from("blocks").select("blocked_id").eq("blocker_id", state.session.user.id);
    state.blocked = new Set((blocks || []).map((item) => item.blocked_id));
    await loadChats();
    renderApp();
  }

  function renderSignIn() {
    root.innerHTML = `<main class="landing"><section class="welcome"><div class="logo large">c</div><p class="eyebrow">A better place to talk</p><h1>Conversations that feel close.</h1><p>Private messages and lively groups, together in Chatterbox.</p><button id="google" class="google"><b>G</b> Continue with Google</button><small>New accounts start empty. No suggested or fake contacts.</small><div class="trust">◈ Secure accounts <span>•</span> ◎ Free to use <span>•</span> ◇ Built for the web</div></section></main>`;
    root.querySelector("#google").onclick = () => supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin } });
  }

  function renderOnboarding(error = "") {
    const suggested = (state.session.user.user_metadata.full_name || "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20);
    root.innerHTML = `<main class="landing"><form id="onboard" class="welcome compact"><div class="logo large">c</div><p class="eyebrow">Create your identity</p><h1>Choose a username</h1><p>People will use this to find you. You can change your display name later.</p><label>Username</label><div class="username"><span>@</span><input id="username" value="${escapeHtml(suggested)}" maxlength="24" pattern="[a-zA-Z0-9_]{3,24}" required /></div><p class="error">${escapeHtml(error)}</p><button class="primary">Enter Chatterbox</button><small>3–24 letters, numbers or underscores.</small></form></main>`;
    root.querySelector("#onboard").onsubmit = async (event) => {
      event.preventDefault();
      const username = root.querySelector("#username").value.toLowerCase();
      const { error: updateError } = await supabase.from("profiles").update({ username }).eq("id", state.session.user.id);
      if (updateError) return renderOnboarding(updateError.code === "23505" ? "That username is already taken." : updateError.message);
      boot();
    };
  }

  async function loadChats() {
    const { data: memberships } = await supabase.from("conversation_members").select("conversation_id, conversations(id, conversation_type, title, created_at)").eq("user_id", state.session.user.id).order("joined_at", { ascending: false });
    const list = await Promise.all((memberships || []).map(async (membership) => {
      const conversation = membership.conversations;
      const { data: members } = await supabase.from("conversation_members").select("user_id, profiles(id, username, display_name, avatar_url, online)").eq("conversation_id", conversation.id).neq("user_id", state.session.user.id);
      const other = members?.[0]?.profiles;
      const { data: latest } = await supabase.from("messages").select("encrypted_content, created_at").eq("conversation_id", conversation.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
      return { ...conversation, other, name: conversation.conversation_type === "group" ? conversation.title : (other?.display_name || `@${other?.username}`), latest };
    }));
    state.chats = list;
  }

  function renderApp() {
    const name = state.profile.display_name || `@${state.profile.username}`;
    root.innerHTML = `<main class="messenger"><nav class="rail"><div class="logo">c</div><div class="nav-icons"><button class="active" title="Messages">◫</button><button id="groups" title="Create group">♙</button><button id="settings" title="Settings">⚙</button></div><button id="profile" class="avatar me" title="Edit profile">${initials(name)}</button></nav><aside class="inbox"><header><div><p class="eyebrow">Your inbox</p><h2>Messages</h2></div><button id="find" class="new" title="Find people">＋</button></header><div class="search"><span>⌕</span><input id="filter" placeholder="Search your chats" /></div><div id="chat-list" class="chat-list"></div></aside><section id="conversation" class="conversation"></section><div id="modal"></div></main>`;
    root.querySelector("#profile").onclick = () => showProfile(false);
    root.querySelector("#settings").onclick = () => showProfile(true);
    root.querySelector("#groups").onclick = showGroup;
    root.querySelector("#find").onclick = renderFindPeople;
    root.querySelector("#filter").oninput = (event) => renderChatList(event.target.value);
    renderChatList();
    renderConversation();
  }

  function renderChatList(filter = "") {
    const box = root.querySelector("#chat-list");
    const filtered = state.chats.filter((chat) => chat.name.toLowerCase().includes(filter.toLowerCase()));
    if (!filtered.length) {
      box.innerHTML = `<div class="empty"><div>✦</div><h3>${state.chats.length ? "No matching chats" : "Your inbox is empty"}</h3><p>${state.chats.length ? "Try another search." : "Find someone by their username to begin a real conversation."}</p><button id="empty-find" class="primary">Find people</button></div>`;
      box.querySelector("#empty-find")?.addEventListener("click", renderFindPeople);
      return;
    }
    box.innerHTML = filtered.map((chat) => `<button class="chat-row ${state.active === chat.id ? "selected" : ""}" data-id="${chat.id}"><span class="avatar">${initials(chat.name)}</span><span class="chat-copy"><b>${escapeHtml(chat.name)}</b><small>${escapeHtml(chat.latest?.encrypted_content || "New conversation")}</small></span><time>${chat.latest ? time(chat.latest.created_at) : ""}</time></button>`).join("");
    box.querySelectorAll(".chat-row").forEach((button) => button.onclick = () => openChat(button.dataset.id));
  }

  function renderFindPeople() {
    root.querySelector("#conversation").innerHTML = `<section class="finder"><button id="close-find" class="back">‹ Back</button><p class="eyebrow">Real Chatterbox users</p><h2>Find people</h2><p>Search for an exact or partial username.</p><div class="find-box"><span>@</span><input id="people-query" maxlength="24" placeholder="username" autocomplete="off" /></div><div id="people-results" class="people-results"><div class="empty small"><div>⌕</div><p>Search results will appear here.</p></div></div></section>`;
    root.querySelector("#close-find").onclick = renderConversation;
    let timer;
    root.querySelector("#people-query").oninput = (event) => { clearTimeout(timer); timer = setTimeout(() => searchPeople(event.target.value), 300); };
  }

  async function searchPeople(query) {
    const box = root.querySelector("#people-results");
    if (query.trim().length < 2) return box.innerHTML = `<div class="empty small"><p>Enter at least two characters.</p></div>`;
    const { data, error } = await supabase.from("profiles").select("id, username, display_name, avatar_url, online").ilike("username", `%${query.trim()}%`).neq("id", state.session.user.id).limit(15);
    if (error) return box.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
    if (!data.length) return box.innerHTML = `<div class="empty small"><div>⌕</div><h3>No users found</h3><p>Check the spelling of the username.</p></div>`;
    box.innerHTML = data.map((person) => `<button class="person-row" data-id="${person.id}"><span class="avatar">${initials(person.display_name || person.username)}</span><span><b>${escapeHtml(person.display_name || person.username)}</b><small>@${escapeHtml(person.username)}</small></span><em>${person.online ? "Online" : "Message"}</em></button>`).join("");
    box.querySelectorAll(".person-row").forEach((button) => button.onclick = () => startDirectChat(button.dataset.id));
  }

  async function startDirectChat(otherUserId) {
    const existing = state.chats.find((chat) => chat.other?.id === otherUserId && chat.conversation_type === "private");
    if (existing) return openChat(existing.id);
    const id = crypto.randomUUID();
    const { error } = await supabase.from("conversations").insert({ id, conversation_type: "private", created_by: state.session.user.id });
    if (error) return alert(error.message);
    const { error: membersError } = await supabase.from("conversation_members").insert([{ conversation_id: id, user_id: state.session.user.id, member_role: "owner" }, { conversation_id: id, user_id: otherUserId, member_role: "member" }]);
    if (membersError) return alert(membersError.message);
    await loadChats();
    openChat(id);
  }

  async function openChat(id) {
    state.active = id;
    if (state.channel) await supabase.removeChannel(state.channel);
    const { data } = await supabase.from("messages").select("*, message_reactions(emoji,user_id), message_receipts(user_id,read_at)").eq("conversation_id", id).order("created_at", { ascending: true });
    state.messages = data || [];
    state.channel = supabase.channel(`messages:${id}`).on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `conversation_id=eq.${id}` }, async (payload) => { if (!state.messages.some((item) => item.id === payload.new.id)) state.messages.push({...payload.new,message_reactions:[],message_receipts:[]}); await markRead(); renderMessages(); }).on("postgres_changes",{event:"*",schema:"public",table:"message_receipts"},refreshMessages).on("postgres_changes",{event:"*",schema:"public",table:"message_reactions"},refreshMessages).subscribe();
    await markRead();
    listenCalls();
    renderChatList();
    renderConversation();
  }

  function renderConversation() {
    const view = root.querySelector("#conversation");
    const chat = state.chats.find((item) => item.id === state.active);
    if (!chat) return view.innerHTML = `<div class="conversation-empty"><div class="logo large">c</div><h2>Welcome to Chatterbox</h2><p>Your real conversations will appear here. No fake contacts, no clutter.</p><button id="welcome-find" class="primary">Find someone by username</button><small>◈ Messages are protected by Supabase row-level security.</small></div>`;
    view.innerHTML = `<header class="conversation-head"><div class="avatar">${initials(chat.name)}</div><div><b>${escapeHtml(chat.name)}</b><small>${chat.other?.online ? "Online now" : chat.other?.username ? `@${escapeHtml(chat.other.username)}` : "Group"}</small></div><span></span><button id="voice-call" title="Voice call">♧</button><button id="video-call" title="Video call">▣</button><button id="details" title="Details">•••</button></header><div class="privacy">◈ This chat is only available to its members.</div><div id="messages" class="messages"></div><div id="reply-bar"></div><form id="composer" class="composer"><input id="file" type="file" hidden><button id="attach" type="button" title="Attach file">＋</button><button id="voice-note" type="button" title="Voice message">♩</button><input id="draft" maxlength="4000" placeholder="Write a message…" autocomplete="off" /><button class="send" title="Send">➤</button></form>`;
    view.querySelector("#composer").onsubmit = sendMessage;
    view.querySelector("#details").onclick = showDetails;
    view.querySelector("#voice-call").onclick = () => startCall(false);
    view.querySelector("#video-call").onclick = () => startCall(true);
    view.querySelector("#attach").onclick = () => view.querySelector("#file").click();
    view.querySelector("#file").onchange = e => uploadFile(e.target.files[0]);
    view.querySelector("#voice-note").onclick = recordVoice;
    renderMessages();
  }

  function renderMessages() {
    const box = root.querySelector("#messages");
    if (!box) return;
    box.innerHTML = state.messages.length ? state.messages.map((message) => {const mine=message.sender_id===state.session.user.id;const read=(message.message_receipts||[]).some(r=>r.user_id!==state.session.user.id&&r.read_at);const body=message.file_path?fileHtml(message):`<p>${escapeHtml(message.encrypted_content||"")}</p>`;const reacts=(message.message_reactions||[]).map(r=>r.emoji).join(" ");return `<div class="message-line ${mine?"mine":"theirs"}"><div class="bubble" data-id="${message.id}">${message.reply_to?'<div class="mini-reply">Reply</div>':""}${body}<time>${time(message.created_at)}${mine?` <span class="ticks ${read?"read":""}">✓✓</span>`:""}</time>${reacts?`<div class="reaction-chip">${escapeHtml(reacts)}</div>`:""}<div class="message-actions"><button data-reply>↩</button><button data-react>♡</button></div></div></div>`}).join("") : `<div class="empty messages-empty"><div>👋</div><h3>Start the conversation</h3><p>There are no messages here yet.</p></div>`;
    box.querySelectorAll("[data-reply]").forEach(b=>b.onclick=()=>setReply(b.closest(".bubble").dataset.id));
    box.querySelectorAll("[data-react]").forEach(b=>b.onclick=()=>react(b.closest(".bubble").dataset.id));
    box.scrollTop = box.scrollHeight;
  }

  async function sendMessage(event) {
    event.preventDefault();
    const input = root.querySelector("#draft");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    const { error } = await supabase.from("messages").insert({ conversation_id: state.active, sender_id: state.session.user.id, encrypted_content: text, message_type: "text", reply_to: state.replyTo });
    state.replyTo = null;
    if (error) { input.value = text; alert(error.message); }
  }

  async function refreshMessages(){if(!state.active)return;const{data}=await supabase.from("messages").select("*, message_reactions(emoji,user_id), message_receipts(user_id,read_at)").eq("conversation_id",state.active).order("created_at");state.messages=data||[];renderMessages()}
  async function markRead(){const rows=state.messages.filter(m=>m.sender_id!==state.session.user.id);if(rows.length)await supabase.from("message_receipts").upsert(rows.map(m=>({message_id:m.id,user_id:state.session.user.id,read_at:new Date().toISOString()})),{onConflict:"message_id,user_id"})}
  function setReply(id){state.replyTo=id;const m=state.messages.find(x=>x.id===id);const bar=root.querySelector("#reply-bar");bar.innerHTML=`<div class="reply-bar">Replying to ${escapeHtml((m?.encrypted_content||m?.file_name||"message").slice(0,50))}<button>×</button></div>`;bar.querySelector("button").onclick=()=>{state.replyTo=null;bar.innerHTML=""}}
  async function react(id){const emoji=prompt("Reaction emoji","👍");if(emoji){await supabase.from("message_reactions").upsert({message_id:id,user_id:state.session.user.id,emoji:emoji.slice(0,8)});refreshMessages()}}
  function fileHtml(m){const u=supabase.storage.from("chat-files").getPublicUrl(m.file_path).data.publicUrl;if(m.message_type==="image")return `<img class="message-image" src="${u}" alt="Shared image">`;if(m.message_type==="voice")return `<audio controls src="${u}"></audio>`;return `<a class="file-card" target="_blank" href="${u}">📎 ${escapeHtml(m.file_name||"File")}</a>`}
  async function uploadFile(file,type){if(!file)return;if(file.size>5242880)return alert("Maximum file size is 5 MB.");const path=`${state.active}/${state.session.user.id}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g,"_")}`;const up=await supabase.storage.from("chat-files").upload(path,file);if(up.error)return alert(up.error.message);const kind=type||(file.type.startsWith("image/")?"image":file.type.startsWith("audio/")?"voice":"file");await supabase.from("messages").insert({conversation_id:state.active,sender_id:state.session.user.id,message_type:kind,file_path:path,file_name:file.name,file_size:file.size})}
  async function recordVoice(){try{const stream=await navigator.mediaDevices.getUserMedia({audio:true});const rec=new MediaRecorder(stream),chunks=[];rec.ondataavailable=e=>chunks.push(e.data);rec.onstop=()=>{stream.getTracks().forEach(t=>t.stop());uploadFile(new File([new Blob(chunks,{type:"audio/webm"})],`voice-${Date.now()}.webm`,{type:"audio/webm"}),"voice")};rec.start();const stop=confirm("Recording now. Press OK to stop and send, or Cancel to stop without sending.");rec.stop();if(!stop)rec.onstop=()=>stream.getTracks().forEach(t=>t.stop())}catch(e){alert(`Microphone unavailable: ${e.message}`)}}
  const closeModal=()=>root.querySelector("#modal").innerHTML="";
  function showProfile(settings){const p=state.profile;root.querySelector("#modal").innerHTML=`<div class="modal-back"><form id="profile-form" class="modal"><button type="button" class="modal-close">×</button><h2>${settings?"Settings":"Edit profile"}</h2><label>Profile picture<input id="photo" type="file" accept="image/*"></label><label>Display name<input id="display" value="${escapeHtml(p.display_name||"")}"></label><label>Bio<textarea id="bio">${escapeHtml(p.bio||"")}</textarea></label>${settings?`<label><input id="receipts" type="checkbox" ${p.read_receipts!==false?"checked":""}> Enable blue read receipts</label><label>Messages from strangers<select id="strangers"><option value="requests">Message requests</option><option value="main">Main inbox</option><option value="silent">Silent</option></select></label>`:""}<button class="primary">Save</button><button type="button" id="signout" class="danger-button">Sign out</button></form></div>`;const f=root.querySelector("#profile-form");f.querySelector(".modal-close").onclick=closeModal;f.querySelector("#signout").onclick=()=>supabase.auth.signOut();if(settings)f.querySelector("#strangers").value=p.stranger_messages||"requests";f.onsubmit=async e=>{e.preventDefault();let avatar_url=p.avatar_url;const photo=f.querySelector("#photo").files[0];if(photo){if(photo.size>5242880)return alert("Photo must be under 5 MB.");const path=`avatars/${state.session.user.id}/${Date.now()}`;const up=await supabase.storage.from("chat-files").upload(path,photo);if(up.error)return alert(up.error.message);avatar_url=supabase.storage.from("chat-files").getPublicUrl(path).data.publicUrl}const changes={display_name:f.querySelector("#display").value.trim(),bio:f.querySelector("#bio").value.trim(),avatar_url};if(settings){changes.read_receipts=f.querySelector("#receipts").checked;changes.stranger_messages=f.querySelector("#strangers").value}const{error}=await supabase.from("profiles").update(changes).eq("id",state.session.user.id);if(error)return alert(error.message);state.profile={...p,...changes};closeModal();renderApp()}}
  function showDetails(){const chat=state.chats.find(c=>c.id===state.active);root.querySelector("#modal").innerHTML=`<div class="modal-back"><div class="modal"><button class="modal-close">×</button><h2>${escapeHtml(chat.name)}</h2>${chat.other?`<button id="block" class="menu-button danger-button">${state.blocked.has(chat.other.id)?"Unblock":"Block"} contact</button><button id="report" class="menu-button danger-button">Report contact</button>`:""}</div></div>`;root.querySelector(".modal-close").onclick=closeModal;if(chat.other){root.querySelector("#block").onclick=async()=>{if(state.blocked.has(chat.other.id)){await supabase.from("blocks").delete().eq("blocker_id",state.session.user.id).eq("blocked_id",chat.other.id);state.blocked.delete(chat.other.id)}else{await supabase.from("blocks").insert({blocker_id:state.session.user.id,blocked_id:chat.other.id});state.blocked.add(chat.other.id)}closeModal()};root.querySelector("#report").onclick=async()=>{const reason=prompt("Reason for report");if(reason)await supabase.from("reports").insert({reporter_id:state.session.user.id,reported_user_id:chat.other.id,reason});closeModal()}}}
  function showGroup(){root.querySelector("#modal").innerHTML=`<div class="modal-back"><form id="group-form" class="modal"><button type="button" class="modal-close">×</button><h2>Create group</h2><label>Name<input id="group-name" required></label><label>Usernames separated by commas<textarea id="group-users"></textarea></label><button class="primary">Create</button></form></div>`;root.querySelector(".modal-close").onclick=closeModal;root.querySelector("#group-form").onsubmit=async e=>{e.preventDefault();const names=root.querySelector("#group-users").value.split(",").map(x=>x.trim()).filter(Boolean).slice(0,99);const{data:people}=await supabase.from("profiles").select("id,username").in("username",names);const id=crypto.randomUUID();let{error}=await supabase.from("conversations").insert({id,conversation_type:"group",title:root.querySelector("#group-name").value,created_by:state.session.user.id});if(error)return alert(error.message);error=(await supabase.from("conversation_members").insert([{conversation_id:id,user_id:state.session.user.id,member_role:"owner"},...(people||[]).map(p=>({conversation_id:id,user_id:p.id,member_role:"member"}))])).error;if(error)return alert(error.message);closeModal();await loadChats();openChat(id)}}
  async function listenCalls(){if(state.callChannel)await supabase.removeChannel(state.callChannel);state.callChannel=supabase.channel(`calls:${state.session.user.id}`).on("postgres_changes",{event:"INSERT",schema:"public",table:"call_signals",filter:`recipient_id=eq.${state.session.user.id}`},handleSignal).subscribe()}
  async function prepCall(video,other){state.localStream=await navigator.mediaDevices.getUserMedia({audio:true,video});state.peer=new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"}]});state.localStream.getTracks().forEach(t=>state.peer.addTrack(t,state.localStream));state.peer.onicecandidate=e=>e.candidate&&signal(other,"ice",e.candidate,video);state.peer.ontrack=e=>{const media=root.querySelector("#remote-media");if(media)media.srcObject=e.streams[0]}}
  async function signal(other,kind,payload,video=false){await supabase.from("call_signals").insert({conversation_id:state.active,sender_id:state.session.user.id,recipient_id:other,kind,payload,video})}
  async function startCall(video){const chat=state.chats.find(c=>c.id===state.active);if(!chat?.other)return alert("Group calls are not available yet.");try{await prepCall(video,chat.other.id);const offer=await state.peer.createOffer();await state.peer.setLocalDescription(offer);await signal(chat.other.id,"offer",offer,video);showCall(chat.name,video)}catch(e){endCall();alert(e.message)}}
  async function handleSignal({new:s}){if(s.kind==="offer"){if(!confirm(`Incoming ${s.video?"video":"voice"} call. Answer?`))return signal(s.sender_id,"hangup",{});state.active=s.conversation_id;await prepCall(s.video,s.sender_id);await state.peer.setRemoteDescription(s.payload);const a=await state.peer.createAnswer();await state.peer.setLocalDescription(a);await signal(s.sender_id,"answer",a,s.video);showCall("Incoming call",s.video)}else if(s.kind==="answer"&&state.peer)await state.peer.setRemoteDescription(s.payload);else if(s.kind==="ice"&&state.peer)await state.peer.addIceCandidate(s.payload);else if(s.kind==="hangup")endCall()}
  function showCall(name,video){root.querySelector("#modal").innerHTML=`<div class="call-overlay"><div class="call-card"><h2>${escapeHtml(name)}</h2><p>${video?"Video":"Voice"} call</p>${video?'<video id="remote-media" autoplay playsinline></video>':'<audio id="remote-media" autoplay></audio>'}<button id="hangup" class="hangup">End call</button></div></div>`;root.querySelector("#hangup").onclick=()=>{const c=state.chats.find(x=>x.id===state.active);if(c?.other)signal(c.other.id,"hangup",{});endCall()}}
  function endCall(){state.peer?.close();state.localStream?.getTracks().forEach(t=>t.stop());state.peer=null;state.localStream=null;closeModal()}
  root.addEventListener("click", (event) => { if (event.target?.id === "welcome-find") renderFindPeople(); });
}
