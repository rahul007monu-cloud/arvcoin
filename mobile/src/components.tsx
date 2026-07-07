/**
 * arvcoin — shared UI building blocks.
 */
import { LinearGradient } from "expo-linear-gradient";
import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors, gradient, radius, shadow } from "./theme";

/* ---------- Screen wrapper with ambient glow ---------- */
export function Screen({ children, scroll }: { children: React.ReactNode; scroll?: boolean }) {
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* ambient top glow */}
      <LinearGradient
        colors={["rgba(124,92,255,0.22)", "rgba(0,224,255,0.06)", "transparent"]}
        style={styles.ambient}
        pointerEvents="none"
      />
      <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom"]}>
        {children}
      </SafeAreaView>
    </View>
  );
}

/* ---------- Glassmorphism card ---------- */
export function GlassCard({
  children,
  style,
  gradientBg,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  gradientBg?: boolean;
}) {
  if (gradientBg) {
    return (
      <LinearGradient
        colors={gradient.card}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.card, styles.cardGlass, style]}
      >
        {children}
      </LinearGradient>
    );
  }
  return <View style={[styles.card, styles.cardGlass, style]}>{children}</View>;
}

/* ---------- Gradient text (uses MaskedView-free trick via gradient bg on text) ---------- */
export function GradientText({
  children,
  size = 16,
  weight = "700",
}: {
  children: React.ReactNode;
  size?: number;
  weight?: "400" | "600" | "700" | "800";
}) {
  // Simple approach: colored text (mint) — reliable across platforms.
  return (
    <Text style={{ color: colors.mint, fontSize: size, fontWeight: weight }}>{children}</Text>
  );
}

/* ---------- Primary gradient button ---------- */
export function PrimaryButton({
  label,
  onPress,
  disabled,
  loading,
  style,
}: {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        { opacity: disabled ? 0.5 : pressed ? 0.9 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] },
        style,
      ]}
    >
      <LinearGradient
        colors={gradient.brand}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={[styles.btn, shadow.glow]}
      >
        {loading ? (
          <ActivityIndicator color="#050614" />
        ) : (
          <Text style={styles.btnLabel}>{label}</Text>
        )}
      </LinearGradient>
    </Pressable>
  );
}

/* ---------- Ghost button ---------- */
export function GhostButton({
  label,
  onPress,
  style,
}: {
  label: string;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.ghost, { opacity: pressed ? 0.8 : 1 }, style]}
    >
      <Text style={styles.ghostLabel}>{label}</Text>
    </Pressable>
  );
}

/* ---------- Asset icon chip ---------- */
export function AssetIcon({ glyph, color, size = 44 }: { glyph: string; color: string; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: color + "22",
        borderWidth: 1,
        borderColor: color + "44",
      }}
    >
      <Text style={{ color, fontSize: size * 0.44, fontWeight: "800" }}>{glyph}</Text>
    </View>
  );
}

/* ---------- Pill tag ---------- */
export function Pill({ text, tone = "muted" }: { text: string; tone?: "up" | "down" | "muted" | "cyan" }) {
  const toneColor =
    tone === "up" ? colors.up : tone === "down" ? colors.down : tone === "cyan" ? colors.cyan : colors.muted;
  return (
    <View style={[styles.pill, { backgroundColor: toneColor + "1e", borderColor: toneColor + "40" }]}>
      <Text style={{ color: toneColor, fontSize: 12, fontWeight: "700" }}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  ambient: { position: "absolute", top: 0, left: 0, right: 0, height: 320 },
  card: {
    borderRadius: radius.lg,
    padding: 18,
    ...shadow.card,
  },
  cardGlass: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.stroke,
  },
  btn: {
    height: 54,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  btnLabel: { color: "#050614", fontSize: 16, fontWeight: "800" },
  ghost: {
    height: 54,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.strokeStrong,
  },
  ghostLabel: { color: colors.text, fontSize: 16, fontWeight: "700" },
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    alignSelf: "flex-start",
  },
});
