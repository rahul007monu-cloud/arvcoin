import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import { GhostButton, PrimaryButton, Screen } from "@/components";
import { formatInr, formatUnits, getAsset } from "@/mockData";
import { colors, gradient } from "@/theme";

export default function Success() {
  const router = useRouter();
  const { assetId, amount, units, method } = useLocalSearchParams<{
    assetId: string;
    amount: string;
    units: string;
    method: string;
  }>();
  const asset = getAsset(assetId);

  const scale = useRef(new Animated.Value(0)).current;
  const ringScale = useRef(new Animated.Value(0.6)).current;
  const ringOpacity = useRef(new Animated.Value(0.8)).current;

  useEffect(() => {
    Animated.spring(scale, { toValue: 1, friction: 5, tension: 80, useNativeDriver: true }).start();
    Animated.loop(
      Animated.parallel([
        Animated.timing(ringScale, { toValue: 1.6, duration: 1800, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        Animated.timing(ringOpacity, { toValue: 0, duration: 1800, easing: Easing.out(Easing.ease), useNativeDriver: true }),
      ])
    ).start();
  }, [scale, ringScale, ringOpacity]);

  return (
    <Screen>
      <View style={styles.wrap}>
        <View style={styles.badgeWrap}>
          <Animated.View
            style={[styles.ring, { transform: [{ scale: ringScale }], opacity: ringOpacity }]}
          />
          <Animated.View style={{ transform: [{ scale }] }}>
            <LinearGradient colors={gradient.brand} style={styles.badge}>
              <Ionicons name="checkmark" size={54} color="#050614" />
            </LinearGradient>
          </Animated.View>
        </View>

        <Text style={styles.title}>Investment done! 🎉</Text>
        <Text style={styles.sub}>
          {formatInr(parseInt(amount || "0", 10))} invested in {asset?.name ?? "your asset"} via {method}.
        </Text>

        <View style={styles.receipt}>
          <ReceiptRow label="Asset" value={asset?.name ?? "-"} />
          <ReceiptRow label="Units" value={`${formatUnits(parseFloat(units || "0"))} ${asset?.symbol ?? ""}`} />
          <ReceiptRow label="Amount" value={formatInr(parseInt(amount || "0", 10))} />
          <ReceiptRow
            label="Status"
            value={asset?.type === "crypto" ? "Sent to wallet" : "Order placed"}
            highlight
          />
        </View>

        <View style={{ width: "100%", gap: 12, marginTop: 8 }}>
          <PrimaryButton label="Back to portfolio" onPress={() => router.replace("/")} />
          <GhostButton label="Invest again" onPress={() => router.replace("/pay")} />
        </View>
      </View>
    </Screen>
  );
}

function ReceiptRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <View style={styles.rRow}>
      <Text style={styles.rLabel}>{label}</Text>
      <Text style={[styles.rValue, highlight && { color: colors.mint }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 26 },
  badgeWrap: { alignItems: "center", justifyContent: "center", marginBottom: 26 },
  ring: {
    position: "absolute",
    width: 110,
    height: 110,
    borderRadius: 55,
    borderWidth: 2,
    borderColor: colors.cyan,
  },
  badge: {
    width: 110,
    height: 110,
    borderRadius: 55,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { color: colors.text, fontSize: 26, fontWeight: "800", marginBottom: 8 },
  sub: { color: colors.muted, fontSize: 15, textAlign: "center", lineHeight: 22, marginBottom: 26 },
  receipt: {
    width: "100%",
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.stroke,
    borderRadius: 22,
    padding: 18,
    marginBottom: 26,
  },
  rRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 9 },
  rLabel: { color: colors.muted, fontSize: 14 },
  rValue: { color: colors.text, fontSize: 14, fontWeight: "700" },
});
