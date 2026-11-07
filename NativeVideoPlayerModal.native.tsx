import React from "react";
import { Pressable, Text, View, StyleSheet } from "react-native";
import { VideoView, useVideoPlayer } from "expo-video";

type Props = { uri: string; title: string; onClose: () => void };

export default function NativeVideoPlayerModal({ uri, title, onClose }: Props) {
  const player = useVideoPlayer(uri, (instance) => { instance.play(); });
  return (
    <View style={styles.backdrop}>
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>{title}</Text>
        <Pressable onPress={onClose} style={styles.close} accessibilityLabel="Close player">
          <Text style={styles.closeText}>✕</Text>
        </Pressable>
      </View>
      <VideoView player={player} style={styles.video} nativeControls contentFit="contain" />
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, zIndex: 1000, backgroundColor: "rgba(0,0,0,0.96)", padding: 16 },
  header: { height: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { color: "#fff", fontSize: 17, fontWeight: "700", flex: 1 },
  close: { padding: 10 },
  closeText: { color: "#fff", fontSize: 22 },
  video: { width: "100%", height: "90%", backgroundColor: "#000" },
});
