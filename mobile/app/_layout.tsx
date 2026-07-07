import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StoreProvider } from "@/store";
import { colors } from "@/theme";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StoreProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.bg },
            animation: "slide_from_right",
          }}
        >
          <Stack.Screen name="index" />
          <Stack.Screen name="pay" />
          <Stack.Screen name="choose" />
          <Stack.Screen name="confirm" />
          <Stack.Screen name="success" options={{ animation: "fade" }} />
        </Stack>
      </StoreProvider>
    </SafeAreaProvider>
  );
}
