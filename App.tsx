import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, FlatList, Image, KeyboardAvoidingView, Platform, Pressable,
  SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, TextInput, View,
  useWindowDimensions,
} from "react-native";
import { storageGet, storageSet, storageRemove } from "./storage";
import NativeVideoPlayerModal from "./NativeVideoPlayerModal"; // Platform-specific implementations are selected by Metro.

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

// IPTV providers sometimes return local Windows file paths or malformed CDN
// URLs for channel logos. Convert known local /images paths to the provider
// origin and reject file:// resources so desktop browsers do not spam errors.
function normalizeArtworkUrl(value?: string): string | undefined {
  const raw = String(value || "").trim();
  if (!raw) return undefined;

  const localPath = raw.toLowerCase().lastIndexOf("/images/");
  if (/^file:/i.test(raw) || /^[a-z]:[\\/]/i.test(raw)) {
    if (localPath >= 0 && resolvedProviderBase) {
      try { return new URL(raw.slice(localPath), resolvedProviderBase).toString(); } catch { return undefined; }
    }
    return undefined;
  }

  if (/^\/(?!\/)/.test(raw)) {
    if (!resolvedProviderBase) return undefined;
    try { return new URL(raw, resolvedProviderBase).toString(); } catch { return undefined; }
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    if (!resolvedProviderBase || !raw.includes("/")) return undefined;
    try { return new URL(raw.replace(/^\.\//, ""), resolvedProviderBase).toString(); } catch { return undefined; }
  }

  if (!["http:", "https:"].includes(parsed.protocol)) return undefined;

  // These image hosts repeatedly return forbidden, invalid-certificate, or dead
  // links in the provider catalog. Skip them and let the card show its fallback.
  const blockedArtworkHosts = new Set([
    "i.imgur.com",
    "imgur.com",
    "seeklogo.com",
    "static.wikia.nocookie.net",
    "encrypted-tbn0.gstatic.com",
    "eastgatemall.lk",
    "s3.i3ns.net",
    "xplatinmedia.com",
  ]);
  if (blockedArtworkHosts.has(parsed.hostname.toLowerCase())) return undefined;

  if (parsed.hostname.toLowerCase() === "plexflix.to" &&
      parsed.pathname.toLowerCase().startsWith("/plexflix.to/") &&
      resolvedProviderBase) {
    try {
      const provider = new URL(resolvedProviderBase);
      parsed.protocol = provider.protocol;
      parsed.host = provider.host;
      parsed.pathname = parsed.pathname.replace(/^\/plexflix\.to\//i, "/");
    } catch { return undefined; }
  }

  if (resolvedProviderBase && parsed.protocol === "http:") {
    try {
      const provider = new URL(resolvedProviderBase);
      if (provider.protocol === "https:" && parsed.hostname === provider.hostname) parsed.protocol = "https:";
    } catch { /* Keep the original valid image URL. */ }
  }

  return parsed.toString();
}

const CREDENTIAL_KEY = "agyashtv.savedCredentials";
const FAVORITES_KEY = "agyashtv.myList";
const RECENT_KEY = "agyashtv.recentlyWatched";
const NAV_ITEMS: { key: "live" | "movie" | "series" | "mylist"; label: string; icon: string }[] = [
  { key: "live", label: "Live TV", icon: "◉" },
  { key: "movie", label: "Movies", icon: "▶" },
  { key: "series", label: "Series", icon: "▤" },
  { key: "mylist", label: "My List", icon: "♡" },
];

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

function WebVideoPlayerModal({ uri, title, onClose }: { uri: string; title: string; onClose: () => void }) {
  const videoRef = useRef<any>(null);
  const [playerError, setPlayerError] = useState("");
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let hls: any = null;
    let disposed = false;
    setPlayerError("");

    const showVideoError = () => {
      if (disposed) return;
      const mediaError = video.error;
      const code = mediaError?.code;
      const detail = mediaError?.message || (code ? `Media error ${code}` : "The video source could not be opened.");
      setPlayerError(detail);
    };
    const clearVideoError = () => { if (!disposed) setPlayerError(""); };
    video.addEventListener?.("error", showVideoError);
    video.addEventListener?.("playing", clearVideoError);

    const isHls = uri.toLowerCase().includes(".m3u8") || uri.includes("ext=m3u8");
    if (isHls) {
      try {
        const hlsModule = require("hls.js");
        const HlsConstructor = hlsModule.default || hlsModule;
        if (HlsConstructor.isSupported()) {
          hls = new HlsConstructor({
            enableWorker: true,
            xhrSetup: (xhr: XMLHttpRequest) => { xhr.withCredentials = true; },
          });
          hls.on(HlsConstructor.Events.ERROR, (_event: string, data: any) => {
            if (disposed || !data?.fatal) return;
            const status = Number(data?.response?.code || data?.networkDetails?.status || 0);
            const detail = status
              ? `Stream server returned HTTP ${status}. Check the IPTV provider/CDN and try again.`
              : `Stream could not load (${String(data?.details || "network error")}). Check the provider server and internet connection.`;
            setPlayerError(detail);
          });
          hls.loadSource(uri);
          hls.attachMedia(video);
        } else {
          video.src = uri;
        }
      } catch (error) {
        setPlayerError(error instanceof Error ? error.message : "The HLS video player could not start.");
      }
    } else {
      video.src = uri;
    }

    const play = video.play?.();
    if (play && typeof play.catch === "function") {
      play.catch(() => { /* Browser may require the viewer to press Play. */ });
    }
    return () => {
      disposed = true;
      video.removeEventListener?.("error", showVideoError);
      video.removeEventListener?.("playing", clearVideoError);
      hls?.destroy();
      video.pause?.();
      video.removeAttribute?.("src");
      video.load?.();
    };
  }, [uri, retryKey]);

  return (
    <View style={styles.playerBackdrop}>
      <View style={styles.playerHeader}>
        <Text style={styles.playerTitle} numberOfLines={1}>{title}</Text>
        <Pressable onPress={onClose} style={styles.closeButton} accessibilityRole="button" accessibilityLabel="Close player"><Text style={styles.closeText}>✕</Text></Pressable>
      </View>
      {React.createElement("video" as any, {
        ref: videoRef, controls: true, autoPlay: true, playsInline: true,
        style: { width: "100%", height: "calc(100% - 62px)", marginTop: 12, borderRadius: 10, backgroundColor: "#000" }
      })}
      {!!playerError && <View style={styles.playerErrorCard}>
        <Text style={styles.playerErrorText}>{playerError}</Text>
        <View style={styles.playerErrorActions}>
          <Pressable onPress={() => setRetryKey((value) => value + 1)} style={styles.playerRetryButton} accessibilityRole="button"><Text style={styles.playerRetryText}>Try again</Text></Pressable>
          <Pressable onPress={onClose} style={styles.playerCloseButton} accessibilityRole="button"><Text style={styles.playerRetryText}>Close</Text></Pressable>
        </View>
      </View>}
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

function MediaCard({ item, kind, onPress, saved, onToggleSaved, compact = false }: {
  item: MediaItem; kind: MediaKind; onPress: () => void; saved: boolean; onToggleSaved: () => void; compact?: boolean;
}) {
  const initial = item.name?.trim()?.charAt(0)?.toUpperCase() || "A";
  const image = normalizeArtworkUrl(item.stream_icon || item.cover);
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <View style={[styles.card, compact && styles.recentCard]}>
      <Pressable onPress={onPress} style={({ pressed, focused }) => [styles.poster, pressed && styles.pressed, focused && styles.focused]} accessibilityRole="button">
        {image && !imageFailed
          ? <View style={styles.posterImageArea}><Image source={{ uri: image }} style={styles.posterImage} resizeMode="cover" onError={() => setImageFailed(true)} /></View>
          : <View style={styles.posterFallbackArea}><Text style={styles.posterFallback}>{initial}</Text></View>}
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
  const compactLayout = width < 940;
  const columns = width >= 1400 ? 6 : width >= 1050 ? 5 : width >= 760 ? 4 : width >= 520 ? 3 : 2;
  const [providerUrl, setProviderUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const loadedKindsRef = useRef<Set<MediaKind>>(new Set());
  const loadingKindsRef = useRef<Set<MediaKind>>(new Set());
  const [visibleCount, setVisibleCount] = useState(24);
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
  const [recentlyWatched, setRecentlyWatched] = useState<MediaItem[]>([]);
  const [heroIndex, setHeroIndex] = useState(0);
  const [heroImageFailed, setHeroImageFailed] = useState(false);
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
        const savedRecent = await storageGet(RECENT_KEY);
        if (savedRecent) setRecentlyWatched(JSON.parse(savedRecent));
      } catch { /* Ignore corrupt local preferences. */ }
    })();
  }, []);

  const loadLibrary = async (base: string, user: string, pass: string, kind: MediaKind) => {
    if (loadedKindsRef.current.has(kind) || loadingKindsRef.current.has(kind)) return;
    loadingKindsRef.current.add(kind);
    setLoadingLibrary(true);

    const config = kind === "live"
      ? { categories: "get_live_categories", items: "get_live_streams", setCategories: setLiveCategories, setItems: setLive, label: "Live TV" }
      : kind === "movie"
        ? { categories: "get_vod_categories", items: "get_vod_streams", setCategories: setMovieCategories, setItems: setMovies, label: "Movies" }
        : { categories: "get_series_categories", items: "get_series", setCategories: setSeriesCategories, setItems: setSeries, label: "Series" };

    try {
      const [categoryResult, itemResult] = await Promise.allSettled([
        apiRequest<any[]>(base, user, pass, config.categories),
        apiRequest<any[]>(base, user, pass, config.items),
      ]);
      const failures: string[] = [];

      if (categoryResult.status === "fulfilled" && Array.isArray(categoryResult.value)) {
        config.setCategories(categoryResult.value);
      } else {
        config.setCategories([]);
        failures.push("categories");
      }

      if (itemResult.status === "fulfilled" && Array.isArray(itemResult.value)) {
        config.setItems(itemResult.value);
      } else {
        config.setItems([]);
        failures.push("titles");
      }

      if (failures.length === 0) {
        loadedKindsRef.current.add(kind);
      } else {
        setError(`${config.label} could not load its ${failures.join(" and ")}. Check the IPTV provider and try this tab again.`);
      }
    } finally {
      loadingKindsRef.current.delete(kind);
      setLoadingLibrary(loadingKindsRef.current.size > 0);
    }
  };

  const changeTab = (nextTab: "live" | "movie" | "series" | "mylist") => {
    setTab(nextTab);
    setCategory("all");
    setSearch("");
    setVisibleCount(24);
    setEpisodePicker(null);
    setHeroIndex(0);
    setError("");
    if (nextTab !== "mylist") {
      const base = resolvedProviderBase || providerUrl.trim();
      if (base && username.trim() && password) {
        void loadLibrary(base, username.trim(), password, nextTab);
      }
    }
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
      loadedKindsRef.current.clear();
      setUserInfo(result.user_info);
      setSignedIn(true);
      setTab("live");
      setCategory("all");
      setVisibleCount(24);
      if (remember) await storageSet(CREDENTIAL_KEY, JSON.stringify({ providerUrl: normalizedBase, username: user, password: pass }));
      else await storageRemove(CREDENTIAL_KEY);
      await loadLibrary(normalizedBase, user, pass, "live");
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
    loadedKindsRef.current.clear();
    loadingKindsRef.current.clear();
    setLoadingLibrary(false);
    setSignedIn(false); setUserInfo(null); setLive([]); setMovies([]); setSeries([]);
    setLiveCategories([]); setMovieCategories([]); setSeriesCategories([]);
    setSearch(""); setError(""); setAccountOpen(false); setEpisodePicker(null); setPlaying(null);
    setRecentlyWatched([]);
    await storageRemove(CREDENTIAL_KEY);
  };

  const activeList = useMemo(() => {
    if (tab === "mylist") return favorites;
    if (tab === "movie") return movies;
    if (tab === "series") return series;
    return live;
  }, [tab, live, movies, series, favorites]);

  const activeCategories = tab === "movie" ? movieCategories : tab === "series" ? seriesCategories : liveCategories;
  const featuredList = tab === "series" ? series : (tab === "movie" ? movies : (movies.length ? movies : live));
  const featuredItem = featuredList.length ? featuredList[heroIndex % featuredList.length] : null;
  const featuredKind: MediaKind = tab === "series" ? "series" : (tab === "movie" || movies.length ? "movie" : "live");
  const heroArtwork = featuredItem ? normalizeArtworkUrl(featuredItem.cover || featuredItem.stream_icon) : undefined;
  useEffect(() => { setHeroImageFailed(false); }, [heroArtwork]);
  const filtered = useMemo(() => activeList.filter((item) => {
    const matchesSearch = !search.trim() || item.name?.toLowerCase().includes(search.trim().toLowerCase());
    const matchesCategory = category === "all" || String(item.category_id ?? "") === category;
    return matchesSearch && matchesCategory;
  }), [activeList, search, category]);
  const visibleItems = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);
  useEffect(() => { setVisibleCount(24); }, [tab, category, search]);

  const toggleFavorite = async (item: MediaItem, kind: MediaKind) => {
    const key = `${kind}:${item.stream_id ?? item.series_id ?? item.name}`;
    const exists = favorites.some((f) => f._agyashKey === key);
    const next = exists ? favorites.filter((f) => f._agyashKey !== key) : [...favorites, { ...item, _agyashKey: key, _agyashKind: kind }];
    setFavorites(next);
    try { await storageSet(FAVORITES_KEY, JSON.stringify(next)); } catch { /* Favorites are best effort. */ }
  };

  const rememberRecentlyWatched = async (item: MediaItem, kind: MediaKind, displayName?: string) => {
    const key = `${kind}:${item.stream_id ?? item.id ?? item.series_id ?? item.name}`;
    const record = { ...item, name: displayName || item.name, _agyashKey: key, _agyashKind: kind };
    const next = [record, ...recentlyWatched.filter((entry) => entry._agyashKey !== key)].slice(0, 12);
    setRecentlyWatched(next);
    try { await storageSet(RECENT_KEY, JSON.stringify(next)); } catch { /* Viewing history is best effort. */ }
  };

  const playItem = async (item: MediaItem, kind: MediaKind) => {
    setError("");
    if (kind !== "series") {
      const streamId = item.stream_id ?? item.id;
      if (streamId == null || String(streamId).trim() === "") {
        setError(`This ${kind === "movie" ? "movie" : "channel"} has no stream ID from the provider.`);
        return;
      }
      void rememberRecentlyWatched(item, kind);
      setPlaying({ uri: streamUrl(kind, { ...item, stream_id: streamId }, username.trim(), password), title: item.name });
      return;
    }

    const seriesId = item.series_id ?? item.stream_id ?? item.id;
    if (seriesId == null || !/^\d+$/.test(String(seriesId))) {
      setError("This series is missing its provider Series ID. Refresh the Series tab or contact your IPTV provider.");
      return;
    }
    setBusy(true);
    try {
      const detail = await apiRequest<{ episodes?: Record<string, Episode[]> | Episode[] }>(
        resolvedProviderBase || providerUrl.trim(), username.trim(), password, "get_series_info", { series_id: String(seriesId) }
      );
      const episodeValue = detail?.episodes;
      const episodes = (Array.isArray(episodeValue) ? episodeValue : Object.values(episodeValue || {}).flat())
        .filter((episode): episode is Episode => Boolean(episode && (episode.id ?? episode.stream_id)))
        .sort((a, b) => Number(a.season || 0) - Number(b.season || 0) || Number(a.episode_num || 0) - Number(b.episode_num || 0));
      if (!episodes.length) {
        setError("No episodes came back from the provider for this series.");
        return;
      }
      setEpisodePicker({ series: item, episodes });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load series episodes. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const currentKind: MediaKind = tab === "movie" ? "movie" : tab === "series" ? "series" : "live";
  const title = tab === "mylist" ? "My List" : tab === "movie" ? "Movies" : tab === "series" ? "Series" : "Live TV";

  if (!signedIn) {
    return (
      <SafeAreaView style={styles.appShell}>
        <StatusBar barStyle="light-content" backgroundColor="#080808" />
        <KeyboardAvoidingView style={styles.loginRoot} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={styles.loginGlow} />
          <Logo />
          <View style={styles.loginCard}>
            <Text style={styles.eyebrow}>YOUR ENTERTAINMENT HUB</Text>
            <Text style={styles.loginTitle}>Welcome back.</Text>
            <Text style={styles.loginSubtitle}>Enter your IPTV server details to continue.</Text>
            <Text style={styles.fieldLabel}>SERVER / PORTAL URL</Text>
            <TextInput value={providerUrl} onChangeText={setProviderUrl} placeholder="https://your-iptv-server.com:8080" placeholderTextColor="#777777" autoCapitalize="none" autoCorrect={false} keyboardType="url" style={styles.input} returnKeyType="next" />
            <Text style={styles.fieldLabel}>USERNAME</Text>
            <TextInput value={username} onChangeText={setUsername} placeholder="Enter username" placeholderTextColor="#777777" autoCapitalize="none" autoCorrect={false} textContentType="username" style={styles.input} returnKeyType="next" />
            <Text style={styles.fieldLabel}>PASSWORD</Text>
            <TextInput value={password} onChangeText={setPassword} placeholder="Enter password" placeholderTextColor="#777777" secureTextEntry autoCapitalize="none" textContentType="password" style={styles.input} returnKeyType="go" onSubmitEditing={login} />
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
      <StatusBar barStyle="light-content" backgroundColor="#080808" />
      <View style={[styles.topBar, compactLayout && styles.mobileTopBar]}>
        <Logo />
        <View style={styles.topBarActions}>
          {!compactLayout && <View style={styles.searchBox}><Text style={styles.searchIcon}>⌕</Text><TextInput value={search} onChangeText={setSearch} placeholder="Search channels & titles…" placeholderTextColor="#777777" style={styles.searchInput}/>{!!search && <Pressable onPress={() => setSearch("")}><Text style={styles.clearSearch}>×</Text></Pressable>}</View>}
          <View style={styles.accountBadge}><View style={styles.onlineDot}/><Text style={styles.accountBadgeText}>CONNECTED</Text></View>
          <Pressable onPress={() => setAccountOpen((v) => !v)} style={styles.avatarButton} accessibilityRole="button" accessibilityLabel="Account"><Text style={styles.avatarLetter}>{username.slice(0,1).toUpperCase()}</Text></Pressable>
        </View>
      </View>
      {accountOpen && <View style={styles.accountPopover}><Text style={styles.popoverUser}>{userInfo?.username || username}</Text><Text style={styles.popoverMuted}>Status: {userInfo?.status || "Active"}</Text><Pressable onPress={logout} style={styles.logoutButton}><Text style={styles.logoutText}>Sign out</Text></Pressable></View>}
      <View style={styles.mainNavigation} nativeID="agyash-main-navigation">
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.mainNavigationInner}>
          {NAV_ITEMS.map((item) => (
            <Pressable
              key={item.key}
              onPress={() => changeTab(item.key)}
              style={({ pressed, focused }) => [
                styles.mainNavigationButton,
                tab === item.key && styles.mainNavigationButtonActive,
                pressed && styles.mainNavigationButtonPressed,
                focused && styles.focused
              ]}
              accessibilityRole="button"
              accessibilityLabel={item.label}
              accessibilityState={{ selected: tab === item.key }}
              hitSlop={6}
            >
              <Text style={[styles.mainNavigationIcon, tab === item.key && styles.mainNavigationTextActive]}>{item.icon}</Text>
              <Text style={[styles.mainNavigationLabel, tab === item.key && styles.mainNavigationTextActive]}>{item.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>
      <View style={styles.mainLayout}>
        <View style={styles.contentPane}>
          <ScrollView contentContainerStyle={[styles.contentScroll, compactLayout && styles.mobileContentScroll]} showsVerticalScrollIndicator={false}>
            {tab !== "mylist" && <View style={styles.heroBanner}>
              {heroArtwork && !heroImageFailed && <View style={styles.heroImage} pointerEvents="none"><Image source={{ uri: heroArtwork }} style={StyleSheet.absoluteFill} resizeMode="cover" onError={() => setHeroImageFailed(true)}/></View>}
              <View style={styles.heroScrim} pointerEvents="none"/>
              <View style={styles.heroContent}>
                <Text style={styles.heroEyebrow}>{featuredItem ? (featuredKind === "live" ? "NOW STREAMING" : "FEATURED ON AGYASHtv") : "STREAM YOUR WAY"}</Text>
                <Text style={styles.heroTitle} numberOfLines={2}>{featuredItem?.name || "A world of entertainment."}</Text>
                <Text style={styles.heroMeta}>{featuredItem?.category_name || (featuredKind === "live" ? "LIVE TV" : featuredKind === "series" ? "TV SERIES" : "MOVIE")}  ·  AGYASHtv</Text>
                <Text style={styles.heroDescription} numberOfLines={3}>{featuredItem?.plot || "Discover live channels, blockbuster films and your favourite series — all in one place."}</Text>
                <View style={styles.heroActions}>
                  {featuredItem && <Pressable onPress={() => playItem(featuredItem, featuredKind)} style={({ pressed }) => [styles.heroPlayButton, pressed && styles.pressed]}><Text style={styles.heroPlayText}>▶  Play now</Text></Pressable>}
                  <View style={styles.heroChipRow}>
                    <Pressable onPress={() => changeTab("live")} style={({ pressed }) => [styles.heroQuickButton, pressed && styles.mainNavigationButtonPressed]} accessibilityRole="button"><Text style={styles.heroQuickText}>LIVE TV</Text></Pressable>
                    <Pressable onPress={() => changeTab("movie")} style={({ pressed }) => [styles.heroQuickButton, pressed && styles.mainNavigationButtonPressed]} accessibilityRole="button"><Text style={styles.heroQuickText}>MOVIES</Text></Pressable>
                    <Pressable onPress={() => changeTab("series")} style={({ pressed }) => [styles.heroQuickButton, pressed && styles.mainNavigationButtonPressed]} accessibilityRole="button"><Text style={styles.heroQuickText}>SERIES</Text></Pressable>
                  </View>
                </View>
              </View>
              {featuredList.length > 1 && <View style={styles.heroControls}>
                <Pressable onPress={() => setHeroIndex((value) => (value - 1 + featuredList.length) % featuredList.length)} style={styles.heroArrow}><Text style={styles.heroArrowText}>‹</Text></Pressable>
                <Pressable onPress={() => setHeroIndex((value) => (value + 1) % featuredList.length)} style={styles.heroArrow}><Text style={styles.heroArrowText}>›</Text></Pressable>
              </View>}
              {featuredList.length > 1 && <View style={styles.heroDots}>{featuredList.slice(0, 5).map((_item, index) => <Pressable key={index} onPress={() => setHeroIndex(index)} style={[styles.heroDot, index === heroIndex % featuredList.length && styles.heroDotActive]}/>)}</View>}
            </View>}
            {recentlyWatched.length > 0 && tab !== "mylist" && <View style={styles.recentSection}>
              <View style={styles.recentHeader}><View><Text style={styles.recentTitle}>Recently Watched</Text><Text style={styles.sectionSub}>Pick up where you left off</Text></View></View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.recentRow}>
                {recentlyWatched.map((item) => {
                  const kind = (item._agyashKind as MediaKind) || "live";
                  const key = String(item._agyashKey || `${kind}:${item.stream_id ?? item.name}`);
                  const saved = favorites.some((entry) => entry._agyashKey === key);
                  return <View key={key} style={styles.recentCardWrap}><MediaCard item={item} kind={kind} compact saved={saved} onPress={() => playItem(item, kind)} onToggleSaved={() => toggleFavorite(item, kind)}/></View>;
                })}
              </ScrollView>
            </View>}
            <View style={styles.sectionHeading}><View><Text style={styles.sectionTitle}>{title}</Text><Text style={styles.sectionSub}>{loadingLibrary ? "Loading your library…" : `${filtered.length.toLocaleString()} titles available`}</Text></View>{compactLayout && <View style={styles.searchBox}><Text style={styles.searchIcon}>⌕</Text><TextInput value={search} onChangeText={setSearch} placeholder="Search titles…" placeholderTextColor="#777777" style={styles.searchInput}/>{!!search && <Pressable onPress={() => setSearch("")}><Text style={styles.clearSearch}>×</Text></Pressable>}</View>}</View>
            {tab !== "mylist" && activeCategories.length > 0 && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoryRow}><Pressable onPress={() => setCategory("all")} style={[styles.categoryChip, category === "all" && styles.categoryChipActive]}><Text style={[styles.categoryText, category === "all" && styles.categoryTextActive]}>All</Text></Pressable>{activeCategories.map((cat) => <Pressable key={String(cat.category_id)} onPress={() => setCategory(String(cat.category_id))} style={[styles.categoryChip, category === String(cat.category_id) && styles.categoryChipActive]}><Text style={[styles.categoryText, category === String(cat.category_id) && styles.categoryTextActive]}>{cat.category_name}</Text></Pressable>)}</ScrollView>}
            {!!error && <View style={styles.inlineError}><Text style={styles.inlineErrorText}>{error}</Text><Pressable onPress={() => setError("")}><Text style={styles.clearSearch}>×</Text></Pressable></View>}
            {loadingLibrary && !activeList.length ? <View style={styles.loadingBox}><ActivityIndicator size="large" color="#E50914"/><Text style={styles.loadingTitle}>Loading {title}…</Text><Text style={styles.loadingText}>Your library is being prepared</Text></View> : filtered.length === 0 ? <View style={styles.emptyBox}><Text style={styles.emptyGlyph}>{tab === "mylist" ? "♡" : "⌕"}</Text><Text style={styles.emptyTitle}>{tab === "mylist" ? "Your list is waiting" : search ? "No matching titles" : `No ${title} loaded`}</Text><Text style={styles.emptyText}>{tab === "mylist" ? "Tap the heart on any title to save it here." : search ? "Try another title or clear your search." : error || `Your provider returned no ${title.toLowerCase()} yet.`}</Text>{tab !== "mylist" && !search && <Pressable onPress={() => { loadedKindsRef.current.delete(tab); void loadLibrary(resolvedProviderBase || providerUrl.trim(), username.trim(), password, tab); }} style={styles.retryTabButton} accessibilityRole="button"><Text style={styles.retryTabButtonText}>Retry loading {title}</Text></Pressable>}</View> : <View style={styles.grid}>{visibleItems.map((item) => {
              const itemKind = tab === "mylist" ? ((item._agyashKind as MediaKind) || "live") : currentKind;
              const key = String(item._agyashKey || `${itemKind}:${item.stream_id ?? item.series_id ?? item.name}`);
              const saved = favorites.some((f) => f._agyashKey === key);
              return <View key={key} style={[styles.gridItem, { width: `${100 / columns}%` as any }]}><MediaCard item={item} kind={itemKind} onPress={() => playItem(item, itemKind)} saved={saved} onToggleSaved={() => toggleFavorite(item, itemKind)}/></View>;
            })}</View>}
            {visibleItems.length < filtered.length && <Pressable onPress={() => setVisibleCount((count) => count + 24)} style={styles.loadMoreButton} accessibilityRole="button"><Text style={styles.loadMoreText}>Load 24 more  ↓</Text></Pressable>}
            <View style={styles.bottomSpace}/>
          </ScrollView>
        </View>
      </View>
      {busy && signedIn && <View style={styles.actionLoading}><ActivityIndicator size="large" color="#E50914"/><Text style={styles.actionLoadingText}>Opening series…</Text></View>}
      {episodePicker && <View style={styles.episodeBackdrop}><View style={styles.episodePanel}><View style={styles.episodeHeader}><View style={{flex:1}}><Text style={styles.episodeEyebrow}>SERIES EPISODES</Text><Text style={styles.episodeTitle} numberOfLines={1}>{episodePicker.series.name}</Text></View><Pressable onPress={() => setEpisodePicker(null)} style={styles.closeButton}><Text style={styles.closeText}>✕</Text></Pressable></View><FlatList data={episodePicker.episodes} keyExtractor={(episode, index) => String(episode.id || index)} renderItem={({item,index}) => <Pressable onPress={() => {const episodeTitle=`${episodePicker.series.name} · ${item.title || item.name || `Episode ${index+1}`}`;void rememberRecentlyWatched(item,"series",episodeTitle);setEpisodePicker(null);setPlaying({uri:streamUrl("series",item,username.trim(),password),title:episodeTitle});}} style={styles.episodeRow}><View style={styles.episodePlay}><Text style={styles.episodePlayGlyph}>▶</Text></View><View style={{flex:1}}><Text style={styles.episodeName}>{item.title || item.name || `Episode ${index+1}`}</Text><Text style={styles.episodeMeta}>Season {item.season || "—"} · Episode {item.episode_num || index+1}</Text></View><Text style={styles.episodeChevron}>›</Text></Pressable>} /></View></View>}
      {playing && <VideoPlayerModal uri={playing.uri} title={playing.title} onClose={() => setPlaying(null)}/>}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  appShell: { flex: 1, backgroundColor: "#080808" },
  loginRoot: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, overflow: "hidden", minHeight: "100%" },
  loginGlow: { position: "absolute", width: 520, height: 520, borderRadius: 260, backgroundColor: "#211B4B", opacity: 0.65, top: -190, right: -170 },
  logoWrap: { flexDirection: "row", alignItems: "center", gap: 10 },
  logoGlyph: { width: 35, height: 35, borderRadius: 11, backgroundColor: "#E50914", alignItems: "center", justifyContent: "center" },
  logoGlyphText: { color: "#100D25", fontWeight: "900", fontSize: 21 },
  logoText: { color: "#F0EEFF", fontSize: 20, letterSpacing: 1.4, fontWeight: "900" },
  logoAccent: { color: "#E50914" },
  loginCard: { width: "100%", maxWidth: 430, marginTop: 30, padding: 27, backgroundColor: "#171717", borderColor: "#303030", borderWidth: 1, borderRadius: 23 },
  eyebrow: { fontSize: 10, color: "#E50914", fontWeight: "800", letterSpacing: 2 },
  loginTitle: { color: "#F0EEFF", fontSize: 32, lineHeight: 40, fontWeight: "800", marginTop: 10 },
  loginSubtitle: { color: "#A0A0B0", fontSize: 13, lineHeight: 20, marginTop: 7, marginBottom: 25 },
  fieldLabel: { color: "#D9D8E6", fontSize: 10, fontWeight: "800", letterSpacing: 1.5, marginBottom: 8, marginTop: 8 },
  input: { height: 49, borderRadius: 12, borderWidth: 1, borderColor: "#333333", backgroundColor: "#0C0D13", color: "#FFFFFF", paddingHorizontal: 14, fontSize: 14 },
  rememberRow: { flexDirection: "row", alignItems: "center", marginTop: 17, gap: 9 },
  checkbox: { width: 17, height: 17, borderWidth: 1, borderRadius: 5, borderColor: "#69697C", alignItems: "center", justifyContent: "center" },
  checkboxChecked: { backgroundColor: "#E50914", borderColor: "#E50914" },
  checkboxTick: { color: "#100D25", fontSize: 12, fontWeight: "900" },
  rememberText: { color: "#B4B3C4", fontSize: 12 },
  errorText: { color: "#FF959D", fontSize: 12, lineHeight: 18, marginTop: 13 },
  primaryButton: { height: 50, backgroundColor: "#E50914", borderRadius: 12, justifyContent: "center", alignItems: "center", marginTop: 22 },
  primaryButtonText: { color: "#FFFFFF", fontSize: 14, fontWeight: "900", letterSpacing: 0.3 },
  disabledButton: { opacity: 0.7 },
  pressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
  focused: { borderColor: "#B9AAFF", borderWidth: 2, opacity: 1 },
  termsText: { color: "#777777", textAlign: "center", fontSize: 10, lineHeight: 16, marginTop: 17 },
  loginFooter: { color: "#777777", fontWeight: "700", fontSize: 10, letterSpacing: 2, marginTop: 25 },
  topBar: { height: 76, paddingHorizontal: 25, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1, borderBottomColor: "#292929", backgroundColor: "#090A0F" },
  desktopNav: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, flex: 1, marginHorizontal: 22 },
  desktopNavButton: { minHeight: 38, paddingHorizontal: 13, borderRadius: 9, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, backgroundColor: "transparent" },
  desktopNavButtonActive: { backgroundColor: "#242633", borderWidth: 1, borderColor: "#383A4B" },
  desktopNavIcon: { color: "#8D8FA1", fontSize: 14 },
  desktopNavLabel: { color: "#C0C1CD", fontSize: 11, fontWeight: "700" },
  desktopNavTextActive: { color: "#FFFFFF" },
  mainNavigation: { height: 58, backgroundColor: "#111111", borderBottomWidth: 1, borderBottomColor: "#303030", justifyContent: "center" },
  mainNavigationInner: { flexGrow: 1, alignItems: "center", justifyContent: "center", gap: 9, paddingHorizontal: 14 },
  mainNavigationButton: { minWidth: 116, height: 42, paddingHorizontal: 18, borderRadius: 10, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9, backgroundColor: "#1A1A1A", borderWidth: 1, borderColor: "#343434" },
  mainNavigationButtonActive: { backgroundColor: "#E50914", borderColor: "#FF3944" },
  mainNavigationButtonPressed: { opacity: 0.75, transform: [{ scale: 0.98 }] },
  mainNavigationIcon: { color: "#B3B3B3", fontSize: 15, fontWeight: "800" },
  mainNavigationLabel: { color: "#F0EEFF", fontSize: 12, fontWeight: "900", letterSpacing: 0.4 },
  mainNavigationTextActive: { color: "#FFFFFF" },
  heroQuickButton: { minHeight: 34, minWidth: 84, paddingHorizontal: 13, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: "#E50914" },
  heroQuickText: { color: "#FFFFFF", fontSize: 10, fontWeight: "900", letterSpacing: 0.4 },
  retryTabButton: { marginTop: 16, minHeight: 42, paddingHorizontal: 18, paddingVertical: 11, borderRadius: 9, backgroundColor: "#E50914", alignItems: "center", justifyContent: "center" },
  retryTabButtonText: { color: "#FFFFFF", fontSize: 12, fontWeight: "900" },
  loadingTitle: { color: "#FFFFFF", fontSize: 14, fontWeight: "900" },
  mobileNavWrap: { borderBottomWidth: 1, borderBottomColor: "#292929", backgroundColor: "#111111", maxHeight: 60 },
  mobileNav: { paddingHorizontal: 12, paddingVertical: 9, gap: 7, alignItems: "center" },
  mobileNavButton: { minHeight: 39, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, paddingHorizontal: 13, paddingVertical: 8, borderRadius: 10, backgroundColor: "#171717" },
  mobileNavIcon: { color: "#999999", fontSize: 16 },
  mobileNavLabel: { color: "#B3B3B3", fontSize: 11, fontWeight: "700" },
  mobileContentScroll: { paddingHorizontal: 14, paddingTop: 16 },
  mobileTopBar: { height: 60, paddingHorizontal: 14 },
  topBarActions: { flexDirection: "row", alignItems: "center", gap: 16 },
  accountBadge: { flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: "#151A1B", borderColor: "#293638", borderWidth: 1, borderRadius: 20, paddingHorizontal: 11, paddingVertical: 7 },
  onlineDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#70E2A0" },
  accountBadgeText: { color: "#A9E9C3", fontSize: 9, fontWeight: "800", letterSpacing: 1 },
  avatarButton: { width: 36, height: 36, alignItems: "center", justifyContent: "center", backgroundColor: "#301719", borderRadius: 18, borderWidth: 1, borderColor: "#6E2428" },
  avatarLetter: { color: "#FFFFFF", fontSize: 15, fontWeight: "800" },
  accountPopover: { position: "absolute", zIndex: 50, right: 20, top: 63, padding: 17, width: 220, borderRadius: 14, backgroundColor: "#1A1B26", borderWidth: 1, borderColor: "#333344" },
  popoverUser: { color: "#F0EEFF", fontSize: 14, fontWeight: "800" },
  popoverMuted: { color: "#A1A0B1", fontSize: 11, marginTop: 4 },
  logoutButton: { backgroundColor: "#302333", padding: 9, borderRadius: 8, alignItems: "center", marginTop: 13 },
  logoutText: { color: "#FFB2BC", fontSize: 12, fontWeight: "800" },
  mainLayout: { flex: 1, flexDirection: "row" },
  sidebar: { width: 224, paddingHorizontal: 14, paddingTop: 27, borderRightWidth: 1, borderRightColor: "#292929", backgroundColor: "#111111" },
  navCaption: { color: "#68697B", fontSize: 9, letterSpacing: 1.8, fontWeight: "800", marginHorizontal: 13, marginBottom: 17 },
  navButton: { height: 45, borderRadius: 11, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 5 },
  navButtonActive: { backgroundColor: "#25213B" },
  navIcon: { color: "#999999", fontSize: 19, width: 22, textAlign: "center" },
  navLabel: { color: "#B3B3B3", fontWeight: "600", fontSize: 12 },
  navTextActive: { color: "#FF5962", fontWeight: "800" },
  sidebarCategoryBlock: { flex: 1, minHeight: 130, marginTop: 26 },
  sidebarCategoryTitle: { color: "#686B7D", fontSize: 9, letterSpacing: 1.6, fontWeight: "900", marginHorizontal: 12, marginBottom: 10 },
  sidebarCategoryScroll: { flex: 1 },
  sidebarCategoryButton: { minHeight: 36, paddingHorizontal: 12, borderRadius: 8, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 3 },
  sidebarCategoryButtonActive: { backgroundColor: "#191B28" },
  sidebarCategoryText: { color: "#9294A4", fontSize: 10, fontWeight: "600", flex: 1 },
  sidebarCategoryTextActive: { color: "#FFFFFF", fontWeight: "800" },
  sidebarCategoryCount: { color: "#686B7D", fontSize: 9, fontWeight: "700" },
  sidebarFooter: { marginTop: "auto", marginBottom: 25 },
  sidebarDivider: { height: 1, backgroundColor: "#262632", marginBottom: 17 },
  sidebarNote: { color: "#68697B", fontSize: 10 },
  sidebarBrand: { color: "#E50914", fontWeight: "800", fontSize: 12, marginTop: 6, letterSpacing: 0.5 },
  contentPane: { flex: 1, minWidth: 0 },
  contentScroll: { paddingHorizontal: 30, paddingTop: 25, paddingBottom: 30 },
  heroBanner: { minHeight: 355, borderRadius: 23, overflow: "hidden", backgroundColor: "#111111", marginBottom: 34, justifyContent: "center", position: "relative", borderWidth: 1, borderColor: "#272A38" },
  heroImage: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, width: "100%", height: "100%" },
  heroScrim: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: "#070A13AA" },
  heroContent: { maxWidth: 690, paddingVertical: 32, paddingHorizontal: 34, zIndex: 1 },
  heroEyebrow: { color: "#B5D2FF", fontSize: 9, fontWeight: "900", letterSpacing: 2 },
  heroTitle: { color: "#FFFFFF", fontSize: 38, lineHeight: 45, fontWeight: "900", marginTop: 12, maxWidth: 650 },
  heroMeta: { color: "#D5D7E2", fontSize: 11, fontWeight: "800", letterSpacing: 0.6, marginTop: 12 },
  heroDescription: { color: "#E0E1E9", fontSize: 13, lineHeight: 20, marginTop: 13, maxWidth: 520 },
  heroActions: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 16, marginTop: 22 },
  heroPlayButton: { minHeight: 44, paddingHorizontal: 23, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: "#E50914" },
  heroPlayText: { color: "#FFFFFF", fontSize: 12, fontWeight: "900" },
  heroChipRow: { flexDirection: "row", gap: 8, alignItems: "center" },
  heroChip: { color: "#E4EAFB", backgroundColor: "#FFFFFF26", borderRadius: 7, overflow: "hidden", paddingVertical: 7, paddingHorizontal: 11, fontSize: 9, fontWeight: "800", letterSpacing: 0.5 },
  heroControls: { position: "absolute", right: 18, top: "45%", flexDirection: "row", gap: 8, zIndex: 2 },
  heroArrow: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: 20, backgroundColor: "#10152299", borderWidth: 1, borderColor: "#FFFFFF33" },
  heroArrowText: { color: "#FFFFFF", fontSize: 24, lineHeight: 27 },
  heroDots: { position: "absolute", right: 24, bottom: 18, flexDirection: "row", alignItems: "center", gap: 7 },
  heroDot: { width: 7, height: 7, borderRadius: 5, backgroundColor: "#FFFFFF88" },
  heroDotActive: { width: 20, backgroundColor: "#38DDF2" },
  recentSection: { marginBottom: 31 },
  recentHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 },
  recentTitle: { color: "#F6F7FB", fontSize: 19, fontWeight: "900" },
  recentRow: { gap: 14, paddingBottom: 5 },
  recentCardWrap: { width: 156 },
  recentCard: { width: 156 },
  sectionHeading: { flexDirection: "row", gap: 16, justifyContent: "space-between", alignItems: "center", marginBottom: 20 },
  sectionTitle: { color: "#F0EEFF", fontSize: 23, fontWeight: "900" },
  sectionSub: { color: "#999999", fontSize: 11, marginTop: 5 },
  searchBox: { width: 250, maxWidth: "48%", height: 41, borderRadius: 10, borderWidth: 1, borderColor: "#333333", backgroundColor: "#12131A", paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 8 },
  searchIcon: { color: "#9696A8", fontSize: 22 },
  searchInput: { color: "#F5F5FC", flex: 1, fontSize: 12 },
  clearSearch: { color: "#B3B3B3", fontSize: 21, paddingHorizontal: 4 },
  categoryRow: { gap: 8, paddingBottom: 20 },
  categoryChip: { backgroundColor: "#171717", borderRadius: 9, borderWidth: 1, borderColor: "#303030", paddingHorizontal: 13, paddingVertical: 9 },
  categoryChipActive: { backgroundColor: "#351719", borderColor: "#9E1B23" },
  categoryText: { color: "#A5A5B5", fontSize: 11, fontWeight: "700" },
  categoryTextActive: { color: "#FFFFFF" },
  grid: { flexDirection: "row", flexWrap: "wrap", marginHorizontal: -7 },
  gridItem: { paddingHorizontal: 7, marginBottom: 22 },
  card: { minWidth: 0 },
  poster: { width: "100%", aspectRatio: 0.72, borderRadius: 13, backgroundColor: "#202020", overflow: "hidden", position: "relative", borderWidth: 1, borderColor: "#2B2C39", justifyContent: "center", alignItems: "center" },
  posterImageArea: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, justifyContent: "center", alignItems: "center", backgroundColor: "#242020" },
  posterImage: { position: "absolute", width: "100%", height: "100%" },
  posterFallbackArea: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, justifyContent: "center", alignItems: "center", backgroundColor: "#242020" },
  posterFallback: { fontSize: 55, color: "#8A7AD0", fontWeight: "900", opacity: 0.7 },
  posterOverlay: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: "#08080822", alignItems: "center", justifyContent: "center" },
  playGlyph: { color: "#FFFFFF", fontSize: 20, overflow: "hidden", borderRadius: 24, backgroundColor: "#15151FAA", paddingHorizontal: 17, paddingVertical: 13 },
  kindPill: { position: "absolute", top: 9, left: 9, borderRadius: 5, paddingHorizontal: 7, paddingVertical: 5, backgroundColor: "#E50914" },
  kindText: { color: "#130E29", fontSize: 8, fontWeight: "900", letterSpacing: 0.5 },
  cardDetails: { flexDirection: "row", alignItems: "flex-start", marginTop: 9, gap: 6 },
  cardNamePress: { flex: 1 },
  cardName: { color: "#F0EEFF", fontSize: 12, fontWeight: "700", lineHeight: 16 },
  favoriteButton: { width: 23, height: 25, alignItems: "center", justifyContent: "center" },
  favoriteIcon: { color: "#878798", fontSize: 21 },
  favoriteActive: { color: "#C0B5FF" },
  loadingBox: { minHeight: 250, alignItems: "center", justifyContent: "center", gap: 13 },
  loadingText: { color: "#B3B3B3", fontSize: 12 },
  emptyBox: { minHeight: 240, justifyContent: "center", alignItems: "center", padding: 25 },
  emptyGlyph: { color: "#7E70B8", fontSize: 48, marginBottom: 8 },
  emptyTitle: { color: "#E4E3EF", fontSize: 16, fontWeight: "800" },
  emptyText: { maxWidth: 330, textAlign: "center", color: "#89899B", fontSize: 12, lineHeight: 19, marginTop: 8 },
  inlineError: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderColor: "#61313F", backgroundColor: "#28151D", borderRadius: 10, paddingVertical: 10, paddingHorizontal: 13, marginBottom: 15, gap: 10 },
  inlineErrorText: { color: "#FFB5C0", fontSize: 12, flex: 1 },
  loadMoreButton: { alignSelf: "center", minHeight: 44, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 10, backgroundColor: "#E50914", marginTop: 4, marginBottom: 18 },
  loadMoreText: { color: "#FFFFFF", fontSize: 12, fontWeight: "900" },
  actionLoading: { position: "absolute", zIndex: 500, top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "#080808CC", alignItems: "center", justifyContent: "center", gap: 12 },
  actionLoadingText: { color: "#FFFFFF", fontSize: 13, fontWeight: "800" },
  bottomSpace: { height: 30 },
  playerBackdrop: { position: "absolute", zIndex: 200, top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "#050508", padding: 18 },
  playerHeader: { height: 50, flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
  playerTitle: { color: "#F0EEFF", fontSize: 17, fontWeight: "800", flex: 1 },
  closeButton: { width: 39, height: 39, alignItems: "center", justifyContent: "center", backgroundColor: "#252633", borderRadius: 20 },
  closeText: { color: "#F5F5FC", fontSize: 18, fontWeight: "800" },
  video: { flex: 1, width: "100%", marginTop: 12, borderRadius: 10, backgroundColor: "#000" },
  playerErrorCard: { position: "absolute", left: 24, right: 24, bottom: 62, padding: 17, borderRadius: 13, backgroundColor: "#171923F2", borderWidth: 1, borderColor: "#6B3443", alignItems: "center", gap: 12 },
  playerErrorText: { color: "#FFD4DA", fontSize: 12, lineHeight: 18, textAlign: "center" },
  playerErrorActions: { flexDirection: "row", justifyContent: "center", gap: 10 },
  playerRetryButton: { paddingVertical: 10, paddingHorizontal: 18, borderRadius: 9, backgroundColor: "#E50914" },
  playerCloseButton: { paddingVertical: 10, paddingHorizontal: 18, borderRadius: 9, backgroundColor: "#373947" },
  playerRetryText: { color: "#FFFFFF", fontSize: 12, fontWeight: "800" },
  episodeBackdrop: { position: "absolute", zIndex: 150, top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "#000B", alignItems: "center", justifyContent: "center", padding: 20 },
  episodePanel: { maxWidth: 650, width: "100%", maxHeight: "85%", backgroundColor: "#171717", borderWidth: 1, borderColor: "#393746", borderRadius: 18, padding: 18, flex: 1 },
  episodeHeader: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 10 },
  episodeEyebrow: { color: "#E50914", fontSize: 9, letterSpacing: 1.7, fontWeight: "900" },
  episodeTitle: { color: "#F9F8FF", fontSize: 20, fontWeight: "900", marginTop: 4 },
  episodeRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 8, borderBottomColor: "#2C2D38", borderBottomWidth: 1 },
  episodePlay: { width: 37, height: 37, borderRadius: 10, backgroundColor: "#30294B", alignItems: "center", justifyContent: "center" },
  episodePlayGlyph: { color: "#C4B9FF", fontSize: 14 },
  episodeName: { color: "#F5F4FC", fontSize: 13, fontWeight: "700" },
  episodeMeta: { color: "#8D8D9E", fontSize: 10, marginTop: 4 },
  episodeChevron: { color: "#A8A0C8", fontSize: 26 },
});
