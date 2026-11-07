import * as SecureStore from "expo-secure-store";

export async function storageGet(key: string): Promise<string | null> {
  return SecureStore.getItemAsync(key);
}
export async function storageSet(key: string, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value);
}
export async function storageRemove(key: string): Promise<void> {
  await SecureStore.deleteItemAsync(key);
}
