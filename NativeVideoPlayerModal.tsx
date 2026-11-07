import React from "react";
import { View } from "react-native";

type Props = { uri: string; title: string; onClose: () => void };

// Fallback only. Metro selects the .native.tsx or .web.tsx implementation.
export default function NativeVideoPlayerModal(_props: Props) {
  return <View />;
}
