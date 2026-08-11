import { createClient } from "@supabase/supabase-js";
import "./styles.css";

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
  let state = { session: null, profile: null, chats: [], active: null, messages: [], searchResults: [], channel: null };

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
    root.innerHTML = `<main class="messenger"><nav class="rail"><div class="logo">c</div><div class="nav-icons"><button class="active" title="Messages">◫</button><button title="Status">◉</button><button title="Calls">⌕</button></div><button id="logout" class="avatar me" title="Sign out">${initials(name)}</button></nav><aside class="inbox"><header><div><p class="eyebrow">Your inbox</p><h2>Messages</h2></div><button id="find" class="new" title="Find people">＋</button></header><div class="search"><span>⌕</span><input id="filter" placeholder="Search your chats" /></div><div id="chat-list" class="chat-list"></div></aside><section id="conversation" class="conversation"></section></main>`;
    root.querySelector("#logout").onclick = () => supabase.auth.signOut();
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
    const { data } = await supabase.from("messages").select("*").eq("conversation_id", id).order("created_at", { ascending: true });
    state.messages = data || [];
    state.channel = supabase.channel(`messages:${id}`).on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `conversation_id=eq.${id}` }, (payload) => { if (!state.messages.some((item) => item.id === payload.new.id)) state.messages.push(payload.new); renderMessages(); }).subscribe();
    renderChatList();
    renderConversation();
  }

  function renderConversation() {
    const view = root.querySelector("#conversation");
    const chat = state.chats.find((item) => item.id === state.active);
    if (!chat) return view.innerHTML = `<div class="conversation-empty"><div class="logo large">c</div><h2>Welcome to Chatterbox</h2><p>Your real conversations will appear here. No fake contacts, no clutter.</p><button id="welcome-find" class="primary">Find someone by username</button><small>◈ Messages are protected by Supabase row-level security.</small></div>`;
    view.innerHTML = `<header class="conversation-head"><div class="avatar">${initials(chat.name)}</div><div><b>${escapeHtml(chat.name)}</b><small>${chat.other?.online ? "Online now" : chat.other?.username ? `@${escapeHtml(chat.other.username)}` : "Group"}</small></div><span></span><button title="Voice call">♧</button><button title="Video call">▣</button><button title="Details">•••</button></header><div class="privacy">◈ This chat is only available to its members.</div><div id="messages" class="messages"></div><form id="composer" class="composer"><button type="button" title="Attach file">＋</button><button type="button" title="Emoji">☺</button><input id="draft" maxlength="4000" placeholder="Write a message…" autocomplete="off" /><button class="send" title="Send">➤</button></form>`;
    view.querySelector("#composer").onsubmit = sendMessage;
    renderMessages();
  }

  function renderMessages() {
    const box = root.querySelector("#messages");
    if (!box) return;
    box.innerHTML = state.messages.length ? state.messages.map((message) => `<div class="message-line ${message.sender_id === state.session.user.id ? "mine" : "theirs"}"><div class="bubble"><p>${escapeHtml(message.encrypted_content || "")}</p><time>${time(message.created_at)}${message.sender_id === state.session.user.id ? " ✓✓" : ""}</time></div></div>`).join("") : `<div class="empty messages-empty"><div>👋</div><h3>Start the conversation</h3><p>There are no messages here yet.</p></div>`;
    box.scrollTop = box.scrollHeight;
  }

  async function sendMessage(event) {
    event.preventDefault();
    const input = root.querySelector("#draft");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    const { error } = await supabase.from("messages").insert({ conversation_id: state.active, sender_id: state.session.user.id, encrypted_content: text, message_type: "text" });
    if (error) { input.value = text; alert(error.message); }
  }

  root.addEventListener("click", (event) => { if (event.target?.id === "welcome-find") renderFindPeople(); });
}
