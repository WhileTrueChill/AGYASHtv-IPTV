import React from "react";
import { View } from "react-native";

type Props = { uri: string; title: string; onClose: () => void };

// The web player is implemented separately in App.tsx. This platform stub
// ensures the native expo-video module is never imported into the web bundle.
export default function NativeVideoPlayerModal(_props: Props) {
  return <View />;
}
