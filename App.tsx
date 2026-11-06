import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, FlatList, Image, KeyboardAvoidingView, Platform, Pressable,
  SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, TextInput, View,
  useWindowDimensions,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { VideoView, useVideoPlayer } from "expo-video";

type MediaKind = "live" | "movie" | "series";
type Category = { category_id: string | number; category_name: string };
type MediaItem = {
  stream_id?: number | string;
  series_id?: number | string;
  num?: number;
  name: string;
  stream_icon?: string;
  cover?: string;
  category_id?: string | number;
  category_name?: string;
  container_extension?: string;
  stream_type?: string;
  plot?: string;
  [key: string]: any;
};
type Episode = MediaItem & { id: number | string; episode_num?: number; season?: number; container_extension?: string };
type UserInfo = { auth?: number | string; status?: string; exp_date?: string; username?: string; max_connections?: string | number };

let resolvedProviderBase = "";

function readableApiError(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["message", "error_description", "detail", "title"]) {
      const item = record[key];
      if (typeof item === "string" && item.trim()) return item.trim();
    }
    if (typeof record.error === "string" && record.error.trim()) return record.error.trim();
    if (record.error && typeof record.error === "object") {
      return readableApiError(record.error, fallback);
    }
  }
  return fallback;
}

function normalizeProviderBase(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value.trim()); } catch { throw new Error("Enter a valid IPTV Server URL, including http:// or https://."); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("The IPTV Server URL must use HTTP or HTTPS and must not contain embedded credentials.");
  return parsed.toString().replace(/\/+$/, "");
}

const CREDENTIAL_KEY = "agyashtv.savedCredentials";
const FAVORITES_KEY = "agyashtv.myList";
const NAV_ITEMS: { key: "live" | "movie" | "series" | "mylist"; label: string; icon: string }[] = [
  { key: "live", label: "Live TV", icon: "◉" },
  { key: "movie", label: "Movies", icon: "▶" },
  { key: "series", label: "Series", icon: "▤" },
  { key: "mylist", label: "My List", icon: "♡" },
];

async function storageGet(key: string): Promise<string | null> {
  return Platform.OS === "web" ? AsyncStorage.getItem(key) : SecureStore.getItemAsync(key);
}
async function storageSet(key: string, value: string): Promise<void> {
  if (Platform.OS === "web") return AsyncStorage.setItem(key, value);
  return SecureStore.setItemAsync(key, value);
}
async function storageRemove(key: string): Promise<void> {
  if (Platform.OS === "web") return AsyncStorage.removeItem(key);
  return SecureStore.deleteItemAsync(key);
}

async function apiRequest<T>(providerBase: string, username: string, password: string, action?: string, extra: Record<string, string | number> = {}): Promise<T> {
  const params = { ...extra };
  if (Platform.OS === "web") {
    const response = await fetch("/api/xtream", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerBase, username, password, action, params }),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) {
      const fallback = response.status === 401
        ? "Your web login session expired. Please sign in again."
        : `AGYASHtv API request failed (HTTP ${response.status}). Check the Vercel API configuration.`;
      throw new Error(readableApiError(json?.error, fallback));
    }
    return json as T;
  }

  const base = normalizeProviderBase(providerBase);
  resolvedProviderBase = base;
  const query = new URLSearchParams({ username, password, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  if (action) query.set("action", action);
  const response = await fetch(`${base}/player_api.php?${query.toString()}`);
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error("Unable to connect to your IPTV provider.");
  return json as T;
}

function streamUrl(kind: MediaKind, item: MediaItem | Episode, username: string, password: string): string {
  const id = String(kind === "series" ? (item.id ?? item.stream_id ?? "") : (item.stream_id ?? item.id ?? ""));
  const extension = String(item.container_extension || (kind === "live" ? (Platform.OS === "web" ? "m3u8" : "ts") : "mp4")).replace(/[^a-zA-Z0-9]/g, "") || "mp4";
  if (Platform.OS === "web") {
    const query = new URLSearchParams({ mode: "stream", kind, id, ext: extension });
    return `/api/xtream?${query.toString()}`;
  }
  return `${resolvedProviderBase}/${kind === "movie" ? "movie" : kind === "series" ? "series" : "live"}/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${encodeURIComponent(id)}.${extension}`;
}

function NativeVideoPlayerModal({ uri, title, onClose }: { uri: string; title: string; onClose: () => void }) {
  const player = useVideoPlayer(uri, (instance) => { instance.play(); });
  return (
    <View style={styles.playerBackdrop}>
      <View style={styles.playerHeader}>
        <Text style={styles.playerTitle} numberOfLines={1}>{title}</Text>
        <Pressable onPress={onClose} style={styles.closeButton} accessibilityLabel="Close player"><Text style={styles.closeText}>✕</Text></Pressable>
      </View>
      <VideoView player={player} style={styles.video} nativeControls contentFit="contain" />
    </View>
  );
}

function WebVideoPlayerModal({ uri, title, onClose }: { uri: string; title: string; onClose: () => void }) {
  const videoRef = useRef<any>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let hls: any = null;
    const isHls = uri.toLowerCase().includes(".m3u8") || uri.includes("ext=m3u8");
    if (isHls) {
      const hlsModule = require("hls.js");
      const HlsConstructor = hlsModule.default || hlsModule;
      if (HlsConstructor.isSupported()) {
        hls = new HlsConstructor({
        enableWorker: true,
        xhrSetup: (xhr: XMLHttpRequest) => { xhr.withCredentials = true; },
      });
        hls.loadSource(uri);
        hls.attachMedia(video);
      } else {
        video.src = uri;
      }
    } else {
      video.src = uri;
    }
    const play = video.play?.();
    if (play && typeof play.catch === "function") play.catch(() => {});
    return () => { hls?.destroy(); video.pause?.(); video.removeAttribute?.("src"); };
  }, [uri]);
  return (
    <View style={styles.playerBackdrop}>
      <View style={styles.playerHeader}>
        <Text style={styles.playerTitle} numberOfLines={1}>{title}</Text>
        <Pressable onPress={onClose} style={styles.closeButton} accessibilityLabel="Close player"><Text style={styles.closeText}>✕</Text></Pressable>
      </View>
      {React.createElement("video" as any, {
        ref: videoRef, controls: true, autoPlay: true, playsInline: true,
        style: { width: "100%", height: "calc(100% - 62px)", marginTop: 12, borderRadius: 10, backgroundColor: "#000" }
      })}
    </View>
  );
}

function VideoPlayerModal(props: { uri: string; title: string; onClose: () => void }) {
  return Platform.OS === "web"
    ? <WebVideoPlayerModal {...props} />
    : <NativeVideoPlayerModal {...props} />;
}

function Logo() {
  return <View style={styles.logoWrap}><View style={styles.logoGlyph}><Text style={styles.logoGlyphText}>A</Text></View><Text style={styles.logoText}>AGYASH<Text style={styles.logoAccent}>tv</Text></Text></View>;
}

function MediaCard({ item, kind, onPress, saved, onToggleSaved }: {
  item: MediaItem; kind: MediaKind; onPress: () => void; saved: boolean; onToggleSaved: () => void;
}) {
  const initial = item.name?.trim()?.charAt(0)?.toUpperCase() || "A";
  const image = item.stream_icon || item.cover;
  return (
    <View style={styles.card}>
      <Pressable onPress={onPress} style={({ pressed, focused }) => [styles.poster, pressed && styles.pressed, focused && styles.focused]} accessibilityRole="button">
        {image ? <View style={styles.posterImageArea}><Image source={{ uri: image }} style={styles.posterImage} resizeMode="cover" onError={() => {}} /></View> : <View style={styles.posterFallbackArea}><Text style={styles.posterFallback}>{initial}</Text></View>}
        <View style={styles.posterOverlay}><Text style={styles.playGlyph}>▶</Text></View>
        <View style={styles.kindPill}><Text style={styles.kindText}>{kind === "live" ? "LIVE" : kind === "movie" ? "MOVIE" : "SERIES"}</Text></View>
      </Pressable>
      <View style={styles.cardDetails}>
        <Pressable onPress={onPress} style={styles.cardNamePress}><Text style={styles.cardName} numberOfLines={2}>{item.name}</Text></Pressable>
        <Pressable onPress={onToggleSaved} style={styles.favoriteButton} accessibilityLabel={saved ? "Remove from My List" : "Add to My List"}><Text style={[styles.favoriteIcon, saved && styles.favoriteActive]}>{saved ? "♥" : "♡"}</Text></Pressable>
      </View>
    </View>
  );
}

export default function App() {
  const { width } = useWindowDimensions();
  const compactLayout = width < 720;
  const columns = width >= 1400 ? 6 : width >= 1050 ? 5 : width >= 760 ? 4 : width >= 520 ? 3 : 2;
  const [providerUrl, setProviderUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"live" | "movie" | "series" | "mylist">("live");
  const [search, setSearch] = useState("");
  const [live, setLive] = useState<MediaItem[]>([]);
  const [movies, setMovies] = useState<MediaItem[]>([]);
  const [series, setSeries] = useState<MediaItem[]>([]);
  const [liveCategories, setLiveCategories] = useState<Category[]>([]);
  const [movieCategories, setMovieCategories] = useState<Category[]>([]);
  const [seriesCategories, setSeriesCategories] = useState<Category[]>([]);
  const [category, setCategory] = useState<string>("all");
  const [favorites, setFavorites] = useState<MediaItem[]>([]);
  const [playing, setPlaying] = useState<{ uri: string; title: string } | null>(null);
  const [episodePicker, setEpisodePicker] = useState<{ series: MediaItem; episodes: Episode[] } | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const saved = await storageGet(CREDENTIAL_KEY);
        if (saved) {
          const parsed = JSON.parse(saved);
          setProviderUrl(parsed.providerUrl || "");
          setUsername(parsed.username || "");
          setPassword(parsed.password || "");
        }
        const savedFavorites = await storageGet(FAVORITES_KEY);
        if (savedFavorites) setFavorites(JSON.parse(savedFavorites));
      } catch { /* Ignore corrupt local preferences. */ }
    })();
  }, []);

  const loadLibrary = async (base: string, user: string, pass: string) => {
    setLoadingLibrary(true);
    const actions = [
      ["get_live_categories", setLiveCategories], ["get_live_streams", setLive],
      ["get_vod_categories", setMovieCategories], ["get_vod_streams", setMovies],
      ["get_series_categories", setSeriesCategories], ["get_series", setSeries],
    ] as const;
    const results = await Promise.allSettled(actions.map(([action]) => apiRequest<any[]>(base, user, pass, action)));
    results.forEach((result, index) => {
      const setter = actions[index][1] as (data: any[]) => void;
      if (result.status === "fulfilled" && Array.isArray(result.value)) setter(result.value);
      else setter([]);
    });
    setLoadingLibrary(false);
  };

  const login = async () => {
    setError("");
    const base = providerUrl.trim();
    const user = username.trim();
    const pass = password;
    if (!base || !user || !pass) { setError("Enter your Server URL, username and password."); return; }
    setBusy(true);
    try {
      const normalizedBase = normalizeProviderBase(base);
      resolvedProviderBase = normalizedBase;
      const result = await apiRequest<{ user_info?: UserInfo }>(normalizedBase, user, pass);
      if (!result?.user_info || Number(result.user_info.auth) !== 1) {
        throw new Error("Login failed. Check your username/password or contact your IPTV provider.");
      }
      setUserInfo(result.user_info);
      setSignedIn(true);
      setTab("live");
      setCategory("all");
      if (remember) await storageSet(CREDENTIAL_KEY, JSON.stringify({ providerUrl: normalizedBase, username: user, password: pass }));
      else await storageRemove(CREDENTIAL_KEY);
      await loadLibrary(normalizedBase, user, pass);
    } catch (e) {
      setSignedIn(false);
      const message = e instanceof Error ? e.message : readableApiError(e, "Login failed. Try again.");
      setError(message === "[object Object]"
        ? "The server returned an unreadable error. Check the Server URL, username, password and Vercel API deployment, then try again."
        : message);
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    if (Platform.OS === "web") {
      try {
        await fetch("/api/xtream", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ logout: true }),
        });
      } catch { /* Local sign-out still proceeds if the server is unreachable. */ }
    }
    setSignedIn(false); setUserInfo(null); setLive([]); setMovies([]); setSeries([]);
    setSearch(""); setError(""); setAccountOpen(false); setEpisodePicker(null); setPlaying(null);
    await storageRemove(CREDENTIAL_KEY);
  };

  const activeList = useMemo(() => {
    if (tab === "mylist") return favorites;
    if (tab === "movie") return movies;
    if (tab === "series") return series;
    return live;
  }, [tab, live, movies, series, favorites]);

  const activeCategories = tab === "movie" ? movieCategories : tab === "series" ? seriesCategories : liveCategories;
  const filtered = useMemo(() => activeList.filter((item) => {
    const matchesSearch = !search.trim() || item.name?.toLowerCase().includes(search.trim().toLowerCase());
    const matchesCategory = category === "all" || String(item.category_id ?? "") === category;
    return matchesSearch && matchesCategory;
  }), [activeList, search, category]);

  const toggleFavorite = async (item: MediaItem, kind: MediaKind) => {
    const key = `${kind}:${item.stream_id ?? item.series_id ?? item.name}`;
    const exists = favorites.some((f) => f._agyashKey === key);
    const next = exists ? favorites.filter((f) => f._agyashKey !== key) : [...favorites, { ...item, _agyashKey: key, _agyashKind: kind }];
    setFavorites(next);
    try { await storageSet(FAVORITES_KEY, JSON.stringify(next)); } catch { /* Favorites are best effort. */ }
  };

  const playItem = async (item: MediaItem, kind: MediaKind) => {
    if (kind !== "series") {
      setPlaying({ uri: streamUrl(kind, item, username.trim(), password), title: item.name });
      return;
    }
    setBusy(true); setError("");
    try {
      const detail = await apiRequest<{ episodes?: Record<string, Episode[]> }>(resolvedProviderBase, username.trim(), password, "get_series_info", { series_id: item.series_id ?? item.stream_id ?? "" });
      const episodes = Object.values(detail.episodes || {}).flat().sort((a, b) => Number(a.season || 0) - Number(b.season || 0) || Number(a.episode_num || 0) - Number(b.episode_num || 0));
      if (!episodes.length) { setError("No episodes were returned for this series."); return; }
      setEpisodePicker({ series: item, episodes });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load episodes.");
    } finally { setBusy(false); }
  };

  const currentKind: MediaKind = tab === "movie" ? "movie" : tab === "series" ? "series" : "live";
  const title = tab === "mylist" ? "My List" : tab === "movie" ? "Movies" : tab === "series" ? "Series" : "Live TV";

  if (!signedIn) {
    return (
      <SafeAreaView style={styles.appShell}>
        <StatusBar barStyle="light-content" backgroundColor="#08090D" />
        <KeyboardAvoidingView style={styles.loginRoot} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={styles.loginGlow} />
          <Logo />
          <View style={styles.loginCard}>
            <Text style={styles.eyebrow}>YOUR ENTERTAINMENT HUB</Text>
            <Text style={styles.loginTitle}>Welcome back.</Text>
            <Text style={styles.loginSubtitle}>Enter your IPTV server details to continue.</Text>
            <Text style={styles.fieldLabel}>SERVER / PORTAL URL</Text>
            <TextInput value={providerUrl} onChangeText={setProviderUrl} placeholder="https://your-iptv-server.com:8080" placeholderTextColor="#777988" autoCapitalize="none" autoCorrect={false} keyboardType="url" style={styles.input} returnKeyType="next" />
            <Text style={styles.fieldLabel}>USERNAME</Text>
            <TextInput value={username} onChangeText={setUsername} placeholder="Enter username" placeholderTextColor="#777988" autoCapitalize="none" autoCorrect={false} textContentType="username" style={styles.input} returnKeyType="next" />
            <Text style={styles.fieldLabel}>PASSWORD</Text>
            <TextInput value={password} onChangeText={setPassword} placeholder="Enter password" placeholderTextColor="#777988" secureTextEntry autoCapitalize="none" textContentType="password" style={styles.input} returnKeyType="go" onSubmitEditing={login} />
            <Pressable onPress={() => setRemember((v) => !v)} style={styles.rememberRow}><View style={[styles.checkbox, remember && styles.checkboxChecked]}>{remember && <Text style={styles.checkboxTick}>✓</Text>}</View><Text style={styles.rememberText}>Remember me on this device</Text></Pressable>
            {!!error && <Text style={styles.errorText}>{error}</Text>}
            <Pressable onPress={login} disabled={busy} style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, busy && styles.disabledButton]}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Sign In  →</Text>}
            </Pressable>
            <Text style={styles.termsText}>Use only an IPTV subscription you are authorized to access.</Text>
          </View>
          <Text style={styles.loginFooter}>AGYASHtv  •  MOBILE · TV · PC</Text>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.appShell}>
      <StatusBar barStyle="light-content" backgroundColor="#08090D" />
      <View style={[styles.topBar, compactLayout && styles.mobileTopBar]}>
        <Logo />
        <View style={styles.topBarActions}>
          <View style={styles.accountBadge}><View style={styles.onlineDot}/><Text style={styles.accountBadgeText}>CONNECTED</Text></View>
          <Pressable onPress={() => setAccountOpen((v) => !v)} style={styles.avatarButton}><Text style={styles.avatarLetter}>{username.slice(0,1).toUpperCase()}</Text></Pressable>
        </View>
      </View>
      {accountOpen && <View style={styles.accountPopover}><Text style={styles.popoverUser}>{userInfo?.username || username}</Text><Text style={styles.popoverMuted}>Status: {userInfo?.status || "Active"}</Text><Pressable onPress={logout} style={styles.logoutButton}><Text style={styles.logoutText}>Sign out</Text></Pressable></View>}
      {compactLayout && (
        <View style={styles.mobileNavWrap}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.mobileNav}>
            {NAV_ITEMS.map((item) => (
              <Pressable
                key={item.key}
                onPress={() => { setTab(item.key); setCategory("all"); setSearch(""); setEpisodePicker(null); }}
                style={({ focused }) => [styles.mobileNavButton, tab === item.key && styles.navButtonActive, focused && styles.focused]}
                accessibilityRole="button"
                accessibilityLabel={item.label}
              >
                <Text style={[styles.mobileNavIcon, tab === item.key && styles.navTextActive]}>{item.icon}</Text>
                <Text style={[styles.mobileNavLabel, tab === item.key && styles.navTextActive]}>{item.label}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}
      <View style={styles.mainLayout}>
        {!compactLayout && (
          <View style={styles.sidebar}>
            <Text style={styles.navCaption}>DISCOVER</Text>
            {NAV_ITEMS.map((item) => <Pressable key={item.key} onPress={() => { setTab(item.key); setCategory("all"); setSearch(""); setEpisodePicker(null); }} style={({ focused }) => [styles.navButton, tab === item.key && styles.navButtonActive, focused && styles.focused]}><Text style={[styles.navIcon, tab === item.key && styles.navTextActive]}>{item.icon}</Text><Text style={[styles.navLabel, tab === item.key && styles.navTextActive]}>{item.label}</Text></Pressable>)}
            <View style={styles.sidebarFooter}><View style={styles.sidebarDivider}/><Text style={styles.sidebarNote}>Made for your screen.</Text><Text style={styles.sidebarBrand}>AGYASHtv</Text></View>
          </View>
        )}
        <View style={styles.contentPane}>
          <ScrollView contentContainerStyle={[styles.contentScroll, compactLayout && styles.mobileContentScroll]} showsVerticalScrollIndicator={false}>
            {tab !== "mylist" && <View style={styles.heroBanner}><View style={styles.heroCircle}/><Text style={styles.heroEyebrow}>STREAM YOUR WAY</Text><Text style={styles.heroTitle}>A world of entertainment.</Text><Text style={styles.heroDescription}>Live channels, films and series — all in one place.</Text><View style={styles.heroChipRow}><Text style={styles.heroChip}>✦ LIVE</Text><Text style={styles.heroChip}>FILMS</Text><Text style={styles.heroChip}>SERIES</Text></View></View>}
            <View style={styles.sectionHeading}><View><Text style={styles.sectionTitle}>{title}</Text><Text style={styles.sectionSub}>{loadingLibrary ? "Loading your library…" : `${filtered.length.toLocaleString()} titles available`}</Text></View><View style={styles.searchBox}><Text style={styles.searchIcon}>⌕</Text><TextInput value={search} onChangeText={setSearch} placeholder="Search titles…" placeholderTextColor="#777988" style={styles.searchInput}/>{!!search && <Pressable onPress={() => setSearch("")}><Text style={styles.clearSearch}>×</Text></Pressable>}</View></View>
            {tab !== "mylist" && activeCategories.length > 0 && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoryRow}><Pressable onPress={() => setCategory("all")} style={[styles.categoryChip, category === "all" && styles.categoryChipActive]}><Text style={[styles.categoryText, category === "all" && styles.categoryTextActive]}>All</Text></Pressable>{activeCategories.map((cat) => <Pressable key={String(cat.category_id)} onPress={() => setCategory(String(cat.category_id))} style={[styles.categoryChip, category === String(cat.category_id) && styles.categoryChipActive]}><Text style={[styles.categoryText, category === String(cat.category_id) && styles.categoryTextActive]}>{cat.category_name}</Text></Pressable>)}</ScrollView>}
            {!!error && <View style={styles.inlineError}><Text style={styles.inlineErrorText}>{error}</Text><Pressable onPress={() => setError("")}><Text style={styles.clearSearch}>×</Text></Pressable></View>}
            {loadingLibrary && !activeList.length ? <View style={styles.loadingBox}><ActivityIndicator size="large" color="#A99BFF"/><Text style={styles.loadingText}>Preparing your library…</Text></View> : filtered.length === 0 ? <View style={styles.emptyBox}><Text style={styles.emptyGlyph}>{tab === "mylist" ? "♡" : "⌕"}</Text><Text style={styles.emptyTitle}>{tab === "mylist" ? "Your list is waiting" : "Nothing to show just yet"}</Text><Text style={styles.emptyText}>{tab === "mylist" ? "Tap the heart on any title to save it here." : search ? "Try another title or clear your search." : "Check your provider account or try another category."}</Text></View> : <View style={styles.grid}>{filtered.map((item) => {
              const itemKind = tab === "mylist" ? ((item._agyashKind as MediaKind) || "live") : currentKind;
              const key = String(item._agyashKey || `${itemKind}:${item.stream_id ?? item.series_id ?? item.name}`);
              const saved = favorites.some((f) => f._agyashKey === key);
              return <View key={key} style={[styles.gridItem, { width: `${100 / columns}%` as any }]}><MediaCard item={item} kind={itemKind} onPress={() => playItem(item, itemKind)} saved={saved} onToggleSaved={() => toggleFavorite(item, itemKind)}/></View>;
            })}</View>}
            <View style={styles.bottomSpace}/>
          </ScrollView>
        </View>
      </View>
      {episodePicker && <View style={styles.episodeBackdrop}><View style={styles.episodePanel}><View style={styles.episodeHeader}><View style={{flex:1}}><Text style={styles.episodeEyebrow}>SERIES EPISODES</Text><Text style={styles.episodeTitle} numberOfLines={1}>{episodePicker.series.name}</Text></View><Pressable onPress={() => setEpisodePicker(null)} style={styles.closeButton}><Text style={styles.closeText}>✕</Text></Pressable></View><FlatList data={episodePicker.episodes} keyExtractor={(episode, index) => String(episode.id || index)} renderItem={({item,index}) => <Pressable onPress={() => {setEpisodePicker(null); setPlaying({uri:streamUrl("series",item,username.trim(),password),title:`${episodePicker.series.name} · ${item.title || item.name || `Episode ${index+1}`}`});}} style={styles.episodeRow}><View style={styles.episodePlay}><Text style={styles.episodePlayGlyph}>▶</Text></View><View style={{flex:1}}><Text style={styles.episodeName}>{item.title || item.name || `Episode ${index+1}`}</Text><Text style={styles.episodeMeta}>Season {item.season || "—"} · Episode {item.episode_num || index+1}</Text></View><Text style={styles.episodeChevron}>›</Text></Pressable>} /></View></View>}
      {playing && <VideoPlayerModal uri={playing.uri} title={playing.title} onClose={() => setPlaying(null)}/>}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  appShell: { flex: 1, backgroundColor: "#08090D" },
  loginRoot: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, overflow: "hidden", minHeight: "100%" },
  loginGlow: { position: "absolute", width: 520, height: 520, borderRadius: 260, backgroundColor: "#211B4B", opacity: 0.65, top: -190, right: -170 },
  logoWrap: { flexDirection: "row", alignItems: "center", gap: 10 },
  logoGlyph: { width: 35, height: 35, borderRadius: 11, backgroundColor: "#A99BFF", alignItems: "center", justifyContent: "center" },
  logoGlyphText: { color: "#100D25", fontWeight: "900", fontSize: 21 },
  logoText: { color: "#F8F8FC", fontSize: 20, letterSpacing: 1.4, fontWeight: "900" },
  logoAccent: { color: "#A99BFF" },
  loginCard: { width: "100%", maxWidth: 430, marginTop: 30, padding: 27, backgroundColor: "#14151D", borderColor: "#292A37", borderWidth: 1, borderRadius: 23 },
  eyebrow: { fontSize: 10, color: "#A99BFF", fontWeight: "800", letterSpacing: 2 },
  loginTitle: { color: "#F8F8FC", fontSize: 32, lineHeight: 40, fontWeight: "800", marginTop: 10 },
  loginSubtitle: { color: "#A0A0B0", fontSize: 13, lineHeight: 20, marginTop: 7, marginBottom: 25 },
  fieldLabel: { color: "#D9D8E6", fontSize: 10, fontWeight: "800", letterSpacing: 1.5, marginBottom: 8, marginTop: 8 },
  input: { height: 49, borderRadius: 12, borderWidth: 1, borderColor: "#343543", backgroundColor: "#0C0D13", color: "#FFFFFF", paddingHorizontal: 14, fontSize: 14 },
  rememberRow: { flexDirection: "row", alignItems: "center", marginTop: 17, gap: 9 },
  checkbox: { width: 17, height: 17, borderWidth: 1, borderRadius: 5, borderColor: "#69697C", alignItems: "center", justifyContent: "center" },
  checkboxChecked: { backgroundColor: "#A99BFF", borderColor: "#A99BFF" },
  checkboxTick: { color: "#100D25", fontSize: 12, fontWeight: "900" },
  rememberText: { color: "#B4B3C4", fontSize: 12 },
  errorText: { color: "#FF959D", fontSize: 12, lineHeight: 18, marginTop: 13 },
  primaryButton: { height: 50, backgroundColor: "#A99BFF", borderRadius: 12, justifyContent: "center", alignItems: "center", marginTop: 22 },
  primaryButtonText: { color: "#130E29", fontSize: 14, fontWeight: "900", letterSpacing: 0.3 },
  disabledButton: { opacity: 0.7 },
  pressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
  focused: { borderColor: "#B9AAFF", borderWidth: 2, opacity: 1 },
  termsText: { color: "#777889", textAlign: "center", fontSize: 10, lineHeight: 16, marginTop: 17 },
  loginFooter: { color: "#777889", fontWeight: "700", fontSize: 10, letterSpacing: 2, marginTop: 25 },
  topBar: { height: 70, paddingHorizontal: 25, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1, borderBottomColor: "#23232D" },
  mobileTopBar: { height: 60, paddingHorizontal: 14 },
  mobileNavWrap: { borderBottomWidth: 1, borderBottomColor: "#23232D", backgroundColor: "#0B0C12", maxHeight: 60 },
  mobileNav: { paddingHorizontal: 12, paddingVertical: 9, gap: 7, alignItems: "center" },
  mobileNavButton: { minHeight: 39, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, paddingHorizontal: 13, paddingVertical: 8, borderRadius: 10, backgroundColor: "#14151D" },
  mobileNavIcon: { color: "#89899A", fontSize: 16 },
  mobileNavLabel: { color: "#A7A7B8", fontSize: 11, fontWeight: "700" },
  mobileContentScroll: { paddingHorizontal: 14, paddingTop: 16 },
  topBarActions: { flexDirection: "row", alignItems: "center", gap: 16 },
  accountBadge: { flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: "#151A1B", borderColor: "#293638", borderWidth: 1, borderRadius: 20, paddingHorizontal: 11, paddingVertical: 7 },
  onlineDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#70E2A0" },
  accountBadgeText: { color: "#A9E9C3", fontSize: 9, fontWeight: "800", letterSpacing: 1 },
  avatarButton: { width: 36, height: 36, alignItems: "center", justifyContent: "center", backgroundColor: "#29243D", borderRadius: 18, borderWidth: 1, borderColor: "#504777" },
  avatarLetter: { color: "#C8BEFF", fontSize: 15, fontWeight: "800" },
  accountPopover: { position: "absolute", zIndex: 50, right: 20, top: 63, padding: 17, width: 220, borderRadius: 14, backgroundColor: "#1A1B26", borderWidth: 1, borderColor: "#333344" },
  popoverUser: { color: "#F8F8FC", fontSize: 14, fontWeight: "800" },
  popoverMuted: { color: "#A1A0B1", fontSize: 11, marginTop: 4 },
  logoutButton: { backgroundColor: "#302333", padding: 9, borderRadius: 8, alignItems: "center", marginTop: 13 },
  logoutText: { color: "#FFB2BC", fontSize: 12, fontWeight: "800" },
  mainLayout: { flex: 1, flexDirection: "row" },
  sidebar: { width: 190, paddingHorizontal: 14, paddingTop: 27, borderRightWidth: 1, borderRightColor: "#23232D", backgroundColor: "#0B0C12" },
  navCaption: { color: "#68697B", fontSize: 9, letterSpacing: 1.8, fontWeight: "800", marginHorizontal: 13, marginBottom: 17 },
  navButton: { height: 45, borderRadius: 11, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 5 },
  navButtonActive: { backgroundColor: "#25213B" },
  navIcon: { color: "#89899A", fontSize: 19, width: 22, textAlign: "center" },
  navLabel: { color: "#A7A7B8", fontWeight: "600", fontSize: 12 },
  navTextActive: { color: "#C4BAFF", fontWeight: "800" },
  sidebarFooter: { marginTop: "auto", marginBottom: 25 },
  sidebarDivider: { height: 1, backgroundColor: "#262632", marginBottom: 17 },
  sidebarNote: { color: "#68697B", fontSize: 10 },
  sidebarBrand: { color: "#A99BFF", fontWeight: "800", fontSize: 12, marginTop: 6, letterSpacing: 0.5 },
  contentPane: { flex: 1, minWidth: 0 },
  contentScroll: { paddingHorizontal: 26, paddingTop: 23 },
  heroBanner: { minHeight: 175, borderRadius: 20, overflow: "hidden", backgroundColor: "#211C3A", paddingVertical: 25, paddingHorizontal: 27, marginBottom: 28, justifyContent: "center" },
  heroCircle: { position: "absolute", width: 300, height: 300, right: -35, top: -122, borderRadius: 150, borderWidth: 34, borderColor: "#39305E", opacity: 0.8 },
  heroEyebrow: { color: "#B5A9FF", fontSize: 9, fontWeight: "900", letterSpacing: 2 },
  heroTitle: { color: "#FFFFFF", fontSize: 27, fontWeight: "900", marginTop: 8 },
  heroDescription: { color: "#C0BDD4", fontSize: 12, marginTop: 8 },
  heroChipRow: { flexDirection: "row", gap: 8, marginTop: 15 },
  heroChip: { color: "#D9D3FF", backgroundColor: "#3C335D", borderRadius: 7, overflow: "hidden", paddingVertical: 6, paddingHorizontal: 10, fontSize: 9, fontWeight: "800", letterSpacing: 0.5 },
  sectionHeading: { flexDirection: "row", gap: 16, justifyContent: "space-between", alignItems: "center", marginBottom: 20 },
  sectionTitle: { color: "#F8F8FC", fontSize: 22, fontWeight: "900" },
  sectionSub: { color: "#858697", fontSize: 11, marginTop: 5 },
  searchBox: { width: 250, maxWidth: "48%", height: 41, borderRadius: 10, borderWidth: 1, borderColor: "#2F303D", backgroundColor: "#12131A", paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 8 },
  searchIcon: { color: "#9696A8", fontSize: 22 },
  searchInput: { color: "#F5F5FC", flex: 1, fontSize: 12 },
  clearSearch: { color: "#A4A4B5", fontSize: 21, paddingHorizontal: 4 },
  categoryRow: { gap: 8, paddingBottom: 20 },
  categoryChip: { backgroundColor: "#14151D", borderRadius: 9, borderWidth: 1, borderColor: "#292A37", paddingHorizontal: 13, paddingVertical: 9 },
  categoryChipActive: { backgroundColor: "#2A2542", borderColor: "#6B5AB1" },
  categoryText: { color: "#A5A5B5", fontSize: 11, fontWeight: "700" },
  categoryTextActive: { color: "#D1C8FF" },
  grid: { flexDirection: "row", flexWrap: "wrap", marginHorizontal: -7 },
  gridItem: { paddingHorizontal: 7, marginBottom: 22 },
  card: { minWidth: 0 },
  poster: { width: "100%", aspectRatio: 0.72, borderRadius: 13, backgroundColor: "#1C1D28", overflow: "hidden", position: "relative", borderWidth: 1, borderColor: "#2B2C39", justifyContent: "center", alignItems: "center" },
  posterImageArea: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, justifyContent: "center", alignItems: "center", backgroundColor: "#252138" },
  posterImage: { position: "absolute", width: "100%", height: "100%" },
  posterFallbackArea: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, justifyContent: "center", alignItems: "center", backgroundColor: "#252138" },
  posterFallback: { fontSize: 55, color: "#8A7AD0", fontWeight: "900", opacity: 0.7 },
  posterOverlay: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: "#08090D22", alignItems: "center", justifyContent: "center" },
  playGlyph: { color: "#FFFFFF", fontSize: 20, overflow: "hidden", borderRadius: 24, backgroundColor: "#15151FAA", paddingHorizontal: 17, paddingVertical: 13 },
  kindPill: { position: "absolute", top: 9, left: 9, borderRadius: 5, paddingHorizontal: 7, paddingVertical: 5, backgroundColor: "#A99BFF" },
  kindText: { color: "#130E29", fontSize: 8, fontWeight: "900", letterSpacing: 0.5 },
  cardDetails: { flexDirection: "row", alignItems: "flex-start", marginTop: 9, gap: 6 },
  cardNamePress: { flex: 1 },
  cardName: { color: "#F0F0F7", fontSize: 12, fontWeight: "700", lineHeight: 16 },
  favoriteButton: { width: 23, height: 25, alignItems: "center", justifyContent: "center" },
  favoriteIcon: { color: "#878798", fontSize: 21 },
  favoriteActive: { color: "#C0B5FF" },
  loadingBox: { minHeight: 250, alignItems: "center", justifyContent: "center", gap: 13 },
  loadingText: { color: "#A4A4B5", fontSize: 12 },
  emptyBox: { minHeight: 240, justifyContent: "center", alignItems: "center", padding: 25 },
  emptyGlyph: { color: "#7E70B8", fontSize: 48, marginBottom: 8 },
  emptyTitle: { color: "#E4E3EF", fontSize: 16, fontWeight: "800" },
  emptyText: { maxWidth: 330, textAlign: "center", color: "#89899B", fontSize: 12, lineHeight: 19, marginTop: 8 },
  inlineError: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderColor: "#61313F", backgroundColor: "#28151D", borderRadius: 10, paddingVertical: 10, paddingHorizontal: 13, marginBottom: 15, gap: 10 },
  inlineErrorText: { color: "#FFB5C0", fontSize: 12, flex: 1 },
  bottomSpace: { height: 30 },
  playerBackdrop: { position: "absolute", zIndex: 200, top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "#050508", padding: 18 },
  playerHeader: { height: 50, flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
  playerTitle: { color: "#F8F8FC", fontSize: 17, fontWeight: "800", flex: 1 },
  closeButton: { width: 39, height: 39, alignItems: "center", justifyContent: "center", backgroundColor: "#252633", borderRadius: 20 },
  closeText: { color: "#F5F5FC", fontSize: 18, fontWeight: "800" },
  video: { flex: 1, width: "100%", marginTop: 12, borderRadius: 10, backgroundColor: "#000" },
  episodeBackdrop: { position: "absolute", zIndex: 150, top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "#000B", alignItems: "center", justifyContent: "center", padding: 20 },
  episodePanel: { maxWidth: 650, width: "100%", maxHeight: "85%", backgroundColor: "#151620", borderWidth: 1, borderColor: "#393746", borderRadius: 18, padding: 18, flex: 1 },
  episodeHeader: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 10 },
  episodeEyebrow: { color: "#A99BFF", fontSize: 9, letterSpacing: 1.7, fontWeight: "900" },
  episodeTitle: { color: "#F9F8FF", fontSize: 20, fontWeight: "900", marginTop: 4 },
  episodeRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 8, borderBottomColor: "#2C2D38", borderBottomWidth: 1 },
  episodePlay: { width: 37, height: 37, borderRadius: 10, backgroundColor: "#30294B", alignItems: "center", justifyContent: "center" },
  episodePlayGlyph: { color: "#C4B9FF", fontSize: 14 },
  episodeName: { color: "#F5F4FC", fontSize: 13, fontWeight: "700" },
  episodeMeta: { color: "#8D8D9E", fontSize: 10, marginTop: 4 },
  episodeChevron: { color: "#A8A0C8", fontSize: 26 },
});
