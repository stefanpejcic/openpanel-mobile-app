import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  Image,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Alert,
  ActivityIndicator,
  StatusBar,
  Platform,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import { WebView } from 'react-native-webview';

const logoMark = require('./assets/logo-mark.png');

type ServerMeta = {
  id: string;
  name: string;
  baseUrl: string;
  username: string;
};

const SERVERS_KEY = 'oa_servers_meta';
const pwKey = (id: string) => `oa_pw_${id}`;

// strip trailing slash so we can safely concat "${baseUrl}${path}"
function normalizeBaseUrl(raw: string): string {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, '');
}

async function loadServers(): Promise<ServerMeta[]> {
  const raw = await SecureStore.getItemAsync(SERVERS_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ServerMeta[];
  } catch {
    return [];
  }
}

async function saveServers(servers: ServerMeta[]) {
  await SecureStore.setItemAsync(SERVERS_KEY, JSON.stringify(servers));
}

type Screen =
  | { name: 'list' }
  | { name: 'add' }
  | { name: 'connecting'; server: ServerMeta }
  | { name: 'webview'; server: ServerMeta; url: string };

export default function App() {
  const [servers, setServers] = useState<ServerMeta[]>([]);
  const [screen, setScreen] = useState<Screen>({ name: 'list' });

  useEffect(() => {
    loadServers().then(setServers);
  }, []);

  const handleAddServer = useCallback(
    async (name: string, baseUrl: string, username: string, password: string) => {
      const id = `${Date.now()}`;
      const entry: ServerMeta = { id, name, baseUrl: normalizeBaseUrl(baseUrl), username };
      const next = [...servers, entry];
      await saveServers(next);
      await SecureStore.setItemAsync(pwKey(id), password);
      setServers(next);
      setScreen({ name: 'list' });
    },
    [servers]
  );

  const handleDeleteServer = useCallback(
    async (id: string) => {
      const next = servers.filter((s) => s.id !== id);
      await saveServers(next);
      await SecureStore.deleteItemAsync(pwKey(id));
      setServers(next);
    },
    [servers]
  );

  const handleConnect = useCallback(async (server: ServerMeta) => {
    setScreen({ name: 'connecting', server });
    try {
      const password = await SecureStore.getItemAsync(pwKey(server.id));
      const res = await fetch(`${server.baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: server.username, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body?.error || `Login failed (HTTP ${res.status})`);
      }
      const loginPath = body?.login_path;
      if (!loginPath) throw new Error('Server did not return a login link.');
      setScreen({ name: 'webview', server, url: `${server.baseUrl}${loginPath}` });
    } catch (err: any) {
      Alert.alert('Could not connect', err?.message || String(err));
      setScreen({ name: 'list' });
    }
  }, []);

  let content: React.ReactNode;

  if (screen.name === 'add') {
    content = <AddServerScreen onCancel={() => setScreen({ name: 'list' })} onSave={handleAddServer} />;
  } else if (screen.name === 'connecting') {
    content = (
      <SafeAreaView style={styles.centerScreen}>
        <ActivityIndicator size="large" />
        <Text style={styles.mutedText}>Connecting to {screen.server.name}…</Text>
      </SafeAreaView>
    );
  } else if (screen.name === 'webview') {
    content = (
      <SafeAreaView style={styles.webviewSafeArea} edges={['top', 'bottom', 'left', 'right']}>
        <View style={styles.webviewHeader}>
          <TouchableOpacity onPress={() => setScreen({ name: 'list' })} style={styles.webviewCloseBtn}>
            <Text style={styles.webviewCloseText}>‹ Servers</Text>
          </TouchableOpacity>
          <Text style={styles.webviewTitle} numberOfLines={1}>
            {screen.server.name}
          </Text>
          <View style={styles.webviewCloseBtn} />
        </View>
        <WebView
          source={{ uri: screen.url }}
          style={styles.webview}
          sharedCookiesEnabled
          startInLoadingState
          renderLoading={() => (
            <View style={styles.webviewLoading}>
              <ActivityIndicator size="large" />
            </View>
          )}
        />
      </SafeAreaView>
    );
  } else {
    content = (
      <ServerListScreen
        servers={servers}
        onConnect={handleConnect}
        onDelete={handleDeleteServer}
        onAdd={() => setScreen({ name: 'add' })}
      />
    );
  }

  return <SafeAreaProvider>{content}</SafeAreaProvider>;
}

function ServerListScreen({
  servers,
  onConnect,
  onDelete,
  onAdd,
}: {
  servers: ServerMeta[];
  onConnect: (s: ServerMeta) => void;
  onDelete: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.headerRow}>
        <Image source={logoMark} style={styles.headerLogo} resizeMode="contain" />
        <Text style={styles.header}>OpenAdmin</Text>
      </View>
      <FlatList
        data={servers}
        keyExtractor={(s) => s.id}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <Text style={styles.mutedText}>No servers yet. Add one to get started.</Text>
        }
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.serverRow} onPress={() => onConnect(item)}>
            <View style={{ flex: 1 }}>
              <Text style={styles.serverName}>{item.name}</Text>
              <Text style={styles.serverSub}>
                {item.username}@{item.baseUrl.replace(/^https?:\/\//, '')}
              </Text>
            </View>
            <TouchableOpacity
              onPress={() =>
                Alert.alert('Remove server', `Remove ${item.name}?`, [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Remove', style: 'destructive', onPress: () => onDelete(item.id) },
                ])
              }
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Text style={styles.deleteText}>Remove</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        )}
      />
      <TouchableOpacity style={styles.primaryButton} onPress={onAdd}>
        <Text style={styles.primaryButtonText}>+ Add server</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

function AddServerScreen({
  onCancel,
  onSave,
}: {
  onCancel: () => void;
  onSave: (name: string, baseUrl: string, username: string, password: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);

  const canSave = name.trim() && baseUrl.trim() && username.trim() && password.length > 0 && !saving;

  return (
    <SafeAreaView style={styles.screen}>
      <Text style={styles.header}>Add server</Text>
      <View style={styles.form}>
        <Text style={styles.label}>Name</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="My server"
          placeholderTextColor="#999"
        />

        <Text style={styles.label}>Server URL</Text>
        <TextInput
          style={styles.input}
          value={baseUrl}
          onChangeText={setBaseUrl}
          placeholder="panel.example.com or https://1.2.3.4:2087"
          placeholderTextColor="#999"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType={Platform.OS === 'ios' ? 'url' : 'default'}
        />

        <Text style={styles.label}>Username</Text>
        <TextInput
          style={styles.input}
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Text style={styles.label}>Password</Text>
        <View style={styles.passwordRow}>
          <TextInput
            style={[styles.input, styles.passwordInput]}
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!showPassword}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity
            style={styles.passwordToggle}
            onPress={() => setShowPassword((v) => !v)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={styles.passwordToggleText}>{showPassword ? 'Hide' : 'Show'}</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={[styles.primaryButton, !canSave && styles.primaryButtonDisabled]}
          disabled={!canSave}
          onPress={async () => {
            setSaving(true);
            await onSave(name.trim(), baseUrl, username.trim(), password);
            setSaving(false);
          }}
        >
          <Text style={styles.primaryButtonText}>{saving ? 'Saving…' : 'Save'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryButton} onPress={onCancel}>
          <Text style={styles.secondaryButtonText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff', paddingHorizontal: 20, paddingTop: 12 },
  centerScreen: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  headerLogo: { width: 30, height: 30, marginRight: 10 },
  header: { fontSize: 28, fontWeight: '700' },
  mutedText: { color: '#666', marginTop: 12, textAlign: 'center' },
  listContent: { paddingBottom: 12 },
  serverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
  },
  serverName: { fontSize: 17, fontWeight: '600' },
  serverSub: { fontSize: 13, color: '#777', marginTop: 2 },
  deleteText: { color: '#c0392b', fontSize: 13 },
  primaryButton: {
    backgroundColor: '#111',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 12,
    marginBottom: 8,
  },
  primaryButtonDisabled: { opacity: 0.4 },
  primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  secondaryButton: { alignItems: 'center', paddingVertical: 12 },
  secondaryButtonText: { color: '#555', fontSize: 15 },
  form: { marginTop: 8 },
  label: { fontSize: 13, color: '#555', marginTop: 14, marginBottom: 6 },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: '#111',
  },
  passwordRow: { flexDirection: 'row', alignItems: 'center' },
  passwordInput: { flex: 1 },
  passwordToggle: { marginLeft: 10, paddingVertical: 10, paddingHorizontal: 4 },
  passwordToggleText: { color: '#007aff', fontSize: 14, fontWeight: '600' },
  webviewSafeArea: { flex: 1, backgroundColor: '#fff' },
  webviewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
  },
  webviewCloseBtn: { minWidth: 70 },
  webviewCloseText: { fontSize: 16, color: '#007aff' },
  webviewTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '600' },
  webview: { flex: 1 },
  webviewLoading: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
});
