// Fallback module for TypeScript and non-platform-specific tooling.
// Metro selects storage.web.ts or storage.native.ts on supported platforms.
import AsyncStorage from "@react-native-async-storage/async-storage";

export async function storageGet(key: string): Promise<string | null> {
  return AsyncStorage.getItem(key);
}
export async function storageSet(key: string, value: string): Promise<void> {
  await AsyncStorage.setItem(key, value);
}
export async function storageRemove(key: string): Promise<void> {
  await AsyncStorage.removeItem(key);
}
