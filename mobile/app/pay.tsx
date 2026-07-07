import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { PrimaryButton, Screen } from "@/components";
import { formatInr } from "@/mockData";
import { colors, gradient, radius } from "@/theme";
import { LinearGradient } from "expo-linear-gradient";

const QUICK = [100, 500, 1000, 5000];

export default function Pay() {
  const router = useRouter();
  const [amount, setAmount] = useState<number>(0);
  const [method, setMethod] = useState<"UPI" | "QR">("UPI");

  const press = (d: string) => {
    setAmount((prev) => {
      const s = (prev === 0 ? "" : String(prev)) + d;
      const n = parseInt(s.slice(0, 7) || "0", 10);
      return isNaN(n) ? 0 : n;
    });
  };
  const back = () => setAmount((p) => Math.floor(p / 10));

  const canProceed = amount >= 10;

  return (
    <Screen>
      <Header title="Pay & Invest" onBack={() => router.back()} />

      <View style={{ flex: 1, paddingHorizontal: 20 }}>
        {/* amount display */}
        <View style={styles.amountWrap}>
          <Text style={styles.amountCap}>Enter amount</Text>
          <Text style={styles.amount}>{formatInr(amount)}</Text>
          <Text style={styles.min}>Minimum {formatInr(10)}</Text>
        </View>

        {/* quick chips */}
        <View style={styles.quickRow}>
          {QUICK.map((q) => (
            <Pressable key={q} style={styles.quick} onPress={() => setAmount(q)}>
              <Text style={styles.quickTxt}>{formatInr(q)}</Text>
            </Pressable>
          ))}
        </View>

        {/* method toggle */}
        <View style={styles.methodRow}>
          <MethodBtn
            active={method === "UPI"}
            onPress={() => setMethod("UPI")}
            icon="phone-portrait-outline"
            label="UPI ID"
          />
          <MethodBtn
            active={method === "QR"}
            onPress={() => setMethod("QR")}
            icon="qr-code-outline"
            label="Scan QR"
          />
        </View>

        {/* keypad */}
        <View style={styles.keypad}>
          {["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "del"].map((k) => (
            <Pressable
              key={k}
              style={styles.key}
              onPress={() => (k === "del" ? back() : k === "." ? null : press(k))}
            >
              {k === "del" ? (
                <Ionicons name="backspace-outline" size={24} color={colors.text} />
              ) : (
                <Text style={styles.keyTxt}>{k}</Text>
              )}
            </Pressable>
          ))}
        </View>

        <PrimaryButton
          label={canProceed ? "Choose investment" : "Enter min ₹10"}
          disabled={!canProceed}
          onPress={() =>
            router.push({ pathname: "/choose", params: { amount: String(amount), method } })
          }
          style={{ marginTop: "auto", marginBottom: 12 }}
        />
      </View>
    </Screen>
  );
}

function MethodBtn({
  active,
  onPress,
  icon,
  label,
}: {
  active: boolean;
  onPress: () => void;
  icon: any;
  label: string;
}) {
  if (active) {
    return (
      <Pressable style={{ flex: 1 }} onPress={onPress}>
        <LinearGradient
          colors={gradient.card}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[styles.method, { borderColor: colors.cyan }]}
        >
          <Ionicons name={icon} size={20} color={colors.cyan} />
          <Text style={[styles.methodTxt, { color: colors.text }]}>{label}</Text>
        </LinearGradient>
      </Pressable>
    );
  }
  return (
    <Pressable style={[styles.method, { flex: 1 }]} onPress={onPress}>
      <Ionicons name={icon} size={20} color={colors.muted} />
      <Text style={styles.methodTxt}>{label}</Text>
    </Pressable>
  );
}

export function Header({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <View style={styles.header}>
      <Pressable style={styles.backBtn} onPress={onBack}>
        <Ionicons name="chevron-back" size={24} color={colors.text} />
      </Pressable>
      <Text style={styles.headerTitle}>{title}</Text>
      <View style={{ width: 40 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.stroke,
  },
  headerTitle: { color: colors.text, fontSize: 18, fontWeight: "700" },
  amountWrap: { alignItems: "center", marginTop: 20, marginBottom: 8 },
  amountCap: { color: colors.muted, fontSize: 14 },
  amount: { color: colors.text, fontSize: 52, fontWeight: "800", letterSpacing: -1, marginVertical: 4 },
  min: { color: colors.muted2, fontSize: 12 },
  quickRow: { flexDirection: "row", gap: 10, justifyContent: "center", marginTop: 10 },
  quick: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.stroke,
  },
  quickTxt: { color: colors.text, fontWeight: "700", fontSize: 13 },
  methodRow: { flexDirection: "row", gap: 12, marginTop: 22 },
  method: {
    height: 54,
    borderRadius: radius.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.stroke,
  },
  methodTxt: { color: colors.muted, fontWeight: "700", fontSize: 15 },
  keypad: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: 24,
    justifyContent: "space-between",
  },
  key: {
    width: "31%",
    height: 58,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  keyTxt: { color: colors.text, fontSize: 26, fontWeight: "600" },
});
