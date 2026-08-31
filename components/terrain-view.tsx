'use client';

import { useEffect, useRef, useState } from 'react';
import type * as ThreeTypes from 'three/webgpu';

import {
  CHINA_INDIA_BORDER_PARTS,
  CHINA_NEPAL_BORDER_PARTS,
} from '@/data/international-borders';

export type MapProvider = 'GOOGLE' | 'TIANDITU' | 'OPENTOPO' | 'NONE';
export type MapSource = 'AUTO' | 'GOOGLE' | 'TIANDITU' | 'OPENTOPO';

export type TerrainStats = {
  fps: number;
  triangles: number;
  loadedTiles: number;
  loadedMapTiles: number;
  mapProvider: MapProvider;
  totalTiles: number;
  gamepad: string | null;
  gamepadMode: 'DEFAULT' | 'ROLL' | null;
  gamepadDebug: string | null;
  renderer: 'INITIALIZING' | 'WEBGPU' | 'UNAVAILABLE';
};

type Center = { latitude: number; longitude: number };

type TerrainViewProps = {
  center: Center;
  exaggeration: number;
  highDetail: boolean;
  mapOverlay: boolean;
  mapSource: MapSource;
  wireframe: boolean;
  resetSignal: number;
  onStats: (stats: TerrainStats) => void;
};

type TileData = {
  x: number;
  y: number;
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
};

type MapTileData = {
  blob: Blob;
  provider: Exclude<MapProvider, 'NONE'>;
};

type GoogleTileSession = {
  session: string;
  expiry: string;
  tileWidth: number;
  tileHeight: number;
  imageFormat: 'png' | 'jpeg';
};

const ZOOM = 12;
const HORIZON_ZOOM = 10;
const HORIZON_TILE_RADIUS = 3;
const HORIZON_SEGMENTS = 15;
const FAR_HORIZON_ZOOM = 8;
const FAR_HORIZON_TILE_RADIUS = 3;
const FAR_HORIZON_SEGMENTS = 7;
const FAR_HORIZON_ACTIVATION_HEIGHT = 20_000;
const HORIZON_ELEVATION_OFFSET = 1_200;
const GOOGLE_MAP_NEAR_ZOOM_OFFSET = 2;
const GOOGLE_MAP_MID_ZOOM_OFFSET = 1;
const GOOGLE_MAP_FAR_ZOOM_OFFSET = 0;
const GOOGLE_MAP_ULTRA_ZOOM_OFFSET = -1;
const NEAR_TILE_RADIUS = 1;
const FAR_TILE_RADIUS = 3;
const LOD_NEAR_PIXELS = 1_400;
const LOD_MID_PIXELS = 500;
const LOD_FAR_PIXELS = 180;
const LOD_NEAR_HYSTERESIS_PIXELS = 1_100;
const LOD_MID_HYSTERESIS_PIXELS = 380;
const LOD_FAR_HYSTERESIS_PIXELS = 130;
const INITIAL_TILE_COUNT = (NEAR_TILE_RADIUS * 2 + 1) ** 2;
const TILE_COUNT = (FAR_TILE_RADIUS * 2 + 1) ** 2;
const MAX_ELEVATION_CACHE_TILES = 64;
const MAX_MAP_CACHE_TILES = 32;
const GAMEPAD_PIVOT_DISTANCE = 8;
const GAMEPAD_MOVE_SPEED_MPS = 33.34;
const GAMEPAD_TURN_SPEED_RAD = 0.12;
const EARTH_RADIUS = 6_378_137;
const BASE_ELEVATION = 1_850;
const TILE_ENDPOINT =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const MAP_ENDPOINT = 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png';
const GOOGLE_MAPS_API_KEY_STORAGE_KEY = 'gyirong.googleMapsApiKey';
let googleMapsApiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY?.trim() ?? '';
const tiandituApiKey = import.meta.env.VITE_TIANDITU_API_KEY?.trim() ?? '';
let hasPromptedForGoogleKey = false;
const COLOR_STOPS = [
  { h: 1_400, hex: '#17372f' },
  { h: 2_100, hex: '#34553e' },
  { h: 3_000, hex: '#74724d' },
  { h: 4_000, hex: '#8b765d' },
  { h: 4_900, hex: '#9ca0a0' },
  { h: 6_200, hex: '#e4e9e5' },
];
const tileCache = new Map<string, Promise<TileData>>();
const mapTileCache = new Map<string, Promise<MapTileData>>();
let googleTileSessionPromise: Promise<GoogleTileSession> | null = null;

function getGoogleMapsApiKey() {
  if (googleMapsApiKey) return googleMapsApiKey;
  if (typeof window === 'undefined' || hasPromptedForGoogleKey) return null;
  hasPromptedForGoogleKey = true;

  try {
    const savedKey = window.localStorage
      .getItem(GOOGLE_MAPS_API_KEY_STORAGE_KEY)
      ?.trim();
    if (savedKey) {
      googleMapsApiKey = savedKey;
      return googleMapsApiKey;
    }

    const enteredKey = window
      .prompt(
        '请输入 Google Map Tiles API Key（仅保存在此浏览器）。\n\n获取方式：Google Cloud Console → APIs 和服务 → 凭据，创建 API key；启用 Map Tiles API，并限制到当前站点域名。留空则使用 OpenTopoMap。',
      )
      ?.trim();
    if (!enteredKey) return null;
    window.localStorage.setItem(GOOGLE_MAPS_API_KEY_STORAGE_KEY, enteredKey);
    googleMapsApiKey = enteredKey;
    return googleMapsApiKey;
  } catch (error) {
    console.warn('Unable to read Google Maps key from local storage.', error);
    return null;
  }
}

function touchCacheEntry<T>(cache: Map<string, T>, key: string, value: T) {
  cache.delete(key);
  cache.set(key, value);
}

function trimCache<T>(cache: Map<string, T>, maximumSize: number) {
  while (cache.size > maximumSize) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) return;
    cache.delete(oldest);
  }
}

function lonLatToTile(lon: number, lat: number, zoom: number) {
  const scale = 2 ** zoom;
  return {
    x: ((lon + 180) / 360) * scale,
    y:
      ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * scale,
  };
}

function decodeElevation(pixels: Uint8ClampedArray, index: number) {
  const offset = index * 4;
  return (
    pixels[offset] * 256 +
    pixels[offset + 1] +
    pixels[offset + 2] / 256 -
    32_768
  );
}

function heightColor(
  elevation: number,
  target: ThreeTypes.Color,
  stops: Array<{ h: number; c: ThreeTypes.Color }>,
) {
  for (let i = 0; i < stops.length - 1; i += 1) {
    const lower = stops[i];
    const upper = stops[i + 1];
    if (elevation <= upper.h) {
      const amount = Math.max(
        0,
        Math.min(1, (elevation - lower.h) / (upper.h - lower.h)),
      );
      return target.lerpColors(lower.c, upper.c, amount);
    }
  }

  return target.copy(stops[stops.length - 1].c);
}

async function loadTile(x: number, y: number, zoom = ZOOM): Promise<TileData> {
  const key = `${zoom}/${x}/${y}`;
  const cached = tileCache.get(key);
  if (cached) {
    touchCacheEntry(tileCache, key, cached);
    return cached;
  }

  const task = loadTileUncached(x, y, zoom).catch((error) => {
    tileCache.delete(key);
    throw error;
  });
  tileCache.set(key, task);
  void task.then(() => trimCache(tileCache, MAX_ELEVATION_CACHE_TILES));
  return task;
}

async function loadTileUncached(
  x: number,
  y: number,
  zoom: number,
): Promise<TileData> {
  const url = TILE_ENDPOINT.replace('{z}', `${zoom}`)
    .replace('{x}', `${x}`)
    .replace('{y}', `${y}`);
  const response = await fetch(url, { mode: 'cors' });
  if (!response.ok) throw new Error(`Terrain tile ${zoom}/${x}/${y} failed`);

  const bitmap = await createImageBitmap(await response.blob());
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Unable to decode terrain tile');
  context.drawImage(bitmap, 0, 0);
  const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return { x, y, pixels: image.data, width: image.width, height: image.height };
}

async function getGoogleTileSession(apiKey: string) {
  if (googleTileSessionPromise) return googleTileSessionPromise;

  googleTileSessionPromise = fetch(
    `https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mapType: 'satellite',
        language: 'zh-CN',
        region: 'CN',
        scale: 'scaleFactor2x',
        highDpi: true,
      }),
    },
  )
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Google Map Tiles session failed (${response.status})`);
      }
      return (await response.json()) as GoogleTileSession;
    })
    .catch((error) => {
      googleTileSessionPromise = null;
      throw error;
    });

  return googleTileSessionPromise;
}

function isInChina(latitude: number, longitude: number) {
  return (
    latitude >= 18 && latitude <= 54 && longitude >= 73 && longitude <= 135
  );
}

async function fetchTiandituBitmap(x: number, y: number, zoom: number) {
  const params = new URLSearchParams({
    SERVICE: 'WMTS',
    REQUEST: 'GetTile',
    VERSION: '1.0.0',
    LAYER: 'img',
    STYLE: 'default',
    TILEMATRIXSET: 'w',
    FORMAT: 'tiles',
    TILEMATRIX: `${zoom}`,
    TILEROW: `${y}`,
    TILECOL: `${x}`,
    tk: tiandituApiKey,
  });
  // Spread concurrent high-detail subtile requests across TianDiTu's public
  // tile hosts. A single terrain tile may require up to sixteen image tiles.
  const host = Math.abs(x * 31 + y * 17 + zoom) % 8;
  const response = await fetch(
    `https://t${host}.tianditu.gov.cn/img_w/wmts?${params}`,
    {
      mode: 'cors',
    },
  );
  if (!response.ok) {
    throw new Error(
      `Tianditu image tile ${zoom}/${x}/${y} failed (${response.status})`,
    );
  }
  return createImageBitmap(await response.blob());
}

async function loadTiandituMapTile(
  x: number,
  y: number,
  zoomOffset: number,
  baseZoom: number,
): Promise<MapTileData> {
  const mapZoom = baseZoom + zoomOffset;
  const divisor = zoomOffset < 0 ? 2 ** -zoomOffset : 1;
  const scale = zoomOffset > 0 ? 2 ** zoomOffset : 1;
  const originX = zoomOffset < 0 ? Math.floor(x / divisor) : x * scale;
  const originY = zoomOffset < 0 ? Math.floor(y / divisor) : y * scale;
  const bitmap = await fetchTiandituBitmap(originX, originY, mapZoom);

  if (zoomOffset < 0) {
    const width = bitmap.width / divisor;
    const height = bitmap.height / divisor;
    const column = ((x % divisor) + divisor) % divisor;
    const row = ((y % divisor) + divisor) % divisor;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas
      .getContext('2d')
      ?.drawImage(
        bitmap,
        column * width,
        row * height,
        width,
        height,
        0,
        0,
        width,
        height,
      );
    bitmap.close();
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) =>
          value
            ? resolve(value)
            : reject(new Error('Map texture encoding failed')),
        'image/jpeg',
        0.9,
      ),
    );
    return { blob, provider: 'TIANDITU' };
  }

  const subtiles = [
    { bitmap, column: 0, row: 0 },
    ...(await Promise.all(
      Array.from({ length: scale * scale - 1 }, async (_, index) => {
        const tileIndex = index + 1;
        const column = tileIndex % scale;
        const row = Math.floor(tileIndex / scale);
        return {
          bitmap: await fetchTiandituBitmap(
            originX + column,
            originY + row,
            mapZoom,
          ),
          column,
          row,
        };
      }),
    )),
  ];
  const canvas = document.createElement('canvas');
  const tileWidth = bitmap.width;
  const tileHeight = bitmap.height;
  canvas.width = tileWidth * scale;
  canvas.height = tileHeight * scale;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Unable to compose Tianditu map tiles');
  subtiles.forEach(({ bitmap: subtile, column, row }) => {
    context.drawImage(subtile, column * tileWidth, row * tileHeight);
    subtile.close();
  });
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) =>
        value
          ? resolve(value)
          : reject(new Error('Map texture encoding failed')),
      'image/jpeg',
      0.94,
    ),
  );
  return { blob, provider: 'TIANDITU' };
}

async function loadMapTile(
  x: number,
  y: number,
  mapZoomOffset = GOOGLE_MAP_FAR_ZOOM_OFFSET,
  baseZoom = ZOOM,
  source: MapSource = 'AUTO',
  latitude = 0,
  longitude = 0,
): Promise<MapTileData> {
  const resolvedSource =
    source === 'AUTO'
      ? tiandituApiKey && isInChina(latitude, longitude)
        ? 'TIANDITU'
        : 'GOOGLE'
      : source;
  let apiKey = resolvedSource === 'GOOGLE' ? getGoogleMapsApiKey() : null;
  const key = `${resolvedSource.toLowerCase()}-z${baseZoom + mapZoomOffset}/${baseZoom}/${x}/${y}`;
  const cached = mapTileCache.get(key);
  if (cached) {
    touchCacheEntry(mapTileCache, key, cached);
    return cached;
  }

  const task = (async () => {
    if (resolvedSource === 'TIANDITU' && tiandituApiKey) {
      try {
        return await loadTiandituMapTile(x, y, mapZoomOffset, baseZoom);
      } catch (error) {
        console.warn(
          'Tianditu image tiles unavailable; using fallback.',
          error,
        );
        if (source === 'AUTO') apiKey = getGoogleMapsApiKey();
      }
    }
    if (apiKey) {
      try {
        const session = await getGoogleTileSession(apiKey);
        if (session) {
          const mapZoom = baseZoom + mapZoomOffset;
          if (mapZoomOffset < 0) {
            const divisor = 2 ** -mapZoomOffset;
            const tileX = Math.floor(x / divisor);
            const tileY = Math.floor(y / divisor);
            const url =
              `https://tile.googleapis.com/v1/2dtiles/${mapZoom}/${tileX}/${tileY}` +
              `?session=${encodeURIComponent(session.session)}` +
              `&key=${encodeURIComponent(apiKey)}`;
            const response = await fetch(url, { mode: 'cors' });
            if (!response.ok) {
              throw new Error(
                `Google map tile ${tileX}/${tileY} failed (${response.status})`,
              );
            }
            const bitmap = await createImageBitmap(await response.blob());
            const sourceWidth = bitmap.width / divisor;
            const sourceHeight = bitmap.height / divisor;
            const sourceColumn = ((x % divisor) + divisor) % divisor;
            const sourceRow = ((y % divisor) + divisor) % divisor;
            const canvas = document.createElement('canvas');
            canvas.width = sourceWidth;
            canvas.height = sourceHeight;
            canvas
              .getContext('2d')
              ?.drawImage(
                bitmap,
                sourceColumn * sourceWidth,
                sourceRow * sourceHeight,
                sourceWidth,
                sourceHeight,
                0,
                0,
                sourceWidth,
                sourceHeight,
              );
            bitmap.close();
            const blob = await new Promise<Blob>((resolve, reject) => {
              canvas.toBlob(
                (value) =>
                  value
                    ? resolve(value)
                    : reject(new Error('Map texture encoding failed')),
                session.imageFormat === 'jpeg' ? 'image/jpeg' : 'image/png',
                0.9,
              );
            });
            return { blob, provider: 'GOOGLE' } as const;
          }

          const scale = 2 ** mapZoomOffset;
          const subtiles = await Promise.all(
            Array.from({ length: scale * scale }, async (_, index) => {
              const column = index % scale;
              const row = Math.floor(index / scale);
              const tileX = x * scale + column;
              const tileY = y * scale + row;
              const url =
                `https://tile.googleapis.com/v1/2dtiles/${mapZoom}/${tileX}/${tileY}` +
                `?session=${encodeURIComponent(session.session)}` +
                `&key=${encodeURIComponent(apiKey)}`;
              const response = await fetch(url, { mode: 'cors' });
              if (!response.ok) {
                throw new Error(
                  `Google map tile ${tileX}/${tileY} failed (${response.status})`,
                );
              }
              return {
                bitmap: await createImageBitmap(await response.blob()),
                column,
                row,
              };
            }),
          );

          const canvas = document.createElement('canvas');
          canvas.width = session.tileWidth * scale;
          canvas.height = session.tileHeight * scale;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Unable to compose Google map tiles');
          subtiles.forEach(({ bitmap, column, row }) => {
            context.drawImage(
              bitmap,
              column * session.tileWidth,
              row * session.tileHeight,
            );
            bitmap.close();
          });
          const blob = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(
              (value) =>
                value
                  ? resolve(value)
                  : reject(new Error('Map texture encoding failed')),
              session.imageFormat === 'jpeg' ? 'image/jpeg' : 'image/png',
              0.94,
            );
          });
          return { blob, provider: 'GOOGLE' } as const;
        }
      } catch (error) {
        console.warn('Google Map Tiles unavailable; using OpenTopoMap.', error);
      }
    }

    const url = MAP_ENDPOINT.replace('{z}', `${baseZoom}`)
      .replace('{x}', `${x}`)
      .replace('{y}', `${y}`);
    const response = await fetch(url, { mode: 'cors' });
    if (!response.ok) throw new Error(`Map tile ${x}/${y} failed`);
    return { blob: await response.blob(), provider: 'OPENTOPO' } as const;
  })().catch((error) => {
    mapTileCache.delete(key);
    throw error;
  });

  mapTileCache.set(key, task);
  void task.then(() => trimCache(mapTileCache, MAX_MAP_CACHE_TILES));
  return task;
}

function refineAxis(value: number, deadzone = 0.08) {
  if (Math.abs(value) <= deadzone) return 0;
  const normalized = (Math.abs(value) - deadzone) / (1 - deadzone);
  return Math.sign(value) * normalized * Math.sqrt(normalized);
}

export function TerrainView({
  center,
  exaggeration,
  highDetail,
  mapOverlay,
  mapSource,
  wireframe,
  resetSignal,
  onStats,
}: TerrainViewProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const terrainRef = useRef<ThreeTypes.Group | null>(null);
  const materialRefs = useRef<
    Array<{
      material: ThreeTypes.MeshStandardMaterial;
      texture: ThreeTypes.Texture | null;
    }>
  >([]);
  const northNeedleRef = useRef<HTMLSpanElement>(null);
  const northDialRef = useRef<HTMLSpanElement>(null);
  const northHeadingRef = useRef<HTMLElement>(null);
  const resetRef = useRef<(() => void) | null>(null);
  const exaggerationRef = useRef(exaggeration);
  const mapOverlayRef = useRef(mapOverlay);
  const wireframeRef = useRef(wireframe);
  const statsRef = useRef<TerrainStats>({
    fps: 0,
    triangles: 0,
    loadedTiles: 0,
    loadedMapTiles: 0,
    mapProvider: 'NONE',
    totalTiles: TILE_COUNT,
    gamepad: null,
    gamepadMode: null,
    gamepadDebug: null,
    renderer: 'INITIALIZING',
  });
  const [issue, setIssue] = useState<string | null>(null);
  const [loading, setLoading] = useState('PREPARING WEBGPU');

  useEffect(() => {
    exaggerationRef.current = exaggeration;
    terrainRef.current?.scale.set(1, exaggeration, 1);
  }, [exaggeration]);

  useEffect(() => {
    mapOverlayRef.current = mapOverlay;
    materialRefs.current.forEach(({ material, texture }) => {
      material.map = mapOverlay ? texture : null;
      material.vertexColors = !mapOverlay || !texture;
      material.needsUpdate = true;
    });
  }, [mapOverlay]);

  useEffect(() => {
    wireframeRef.current = wireframe;
    materialRefs.current.forEach(({ material }) => {
      material.wireframe = wireframe;
      material.needsUpdate = true;
    });
  }, [wireframe]);

  useEffect(() => {
    if (resetSignal > 0) resetRef.current?.();
  }, [resetSignal]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const chrome =
      /Chrome\//.test(navigator.userAgent) &&
      !/(Edg|OPR)\//.test(navigator.userAgent);
    const hasWebGPU = 'gpu' in navigator;

    if (!chrome || !hasWebGPU) {
      statsRef.current.renderer = 'UNAVAILABLE';
      onStats({ ...statsRef.current });
      queueMicrotask(() => {
        setIssue(
          chrome
            ? '当前 Chrome 未启用 WebGPU。请升级浏览器并确认硬件加速已开启。'
            : '此地形实验仅支持桌面版 Google Chrome。',
        );
      });
      return;
    }

    let disposed = false;
    let frameHandle = 0;
    let resizeObserver: ResizeObserver | null = null;
    const cleanupListeners: Array<() => void> = [];

    async function initialize() {
      try {
        statsRef.current.loadedTiles = 0;
        statsRef.current.loadedMapTiles = 0;
        statsRef.current.triangles = 0;
        const THREE = await import('three/webgpu');
        if (disposed || !mountRef.current) return;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color('#748a9a');
        scene.fog = new THREE.FogExp2('#748896', 0.000012);

        const camera = new THREE.PerspectiveCamera(46, 1, 10, 180_000);
        const renderer = new THREE.WebGPURenderer({ antialias: true });
        // High-DPI rendering is the biggest steady GPU cost on this full-screen
        // terrain view. 1.5 keeps terrain texture detail readable while cutting
        // pixel shading work substantially on Retina / 4K displays.
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.04;
        await renderer.init();

        if (disposed) {
          renderer.dispose();
          return;
        }

        renderer.domElement.className = 'terrain-canvas';
        renderer.domElement.setAttribute('aria-label', '吉隆口岸三维地形');
        renderer.domElement.setAttribute('role', 'img');
        renderer.domElement.tabIndex = 0;
        mountRef.current.appendChild(renderer.domElement);

        const sky = new THREE.Mesh(
          new THREE.SphereGeometry(150_000, 48, 24),
          new THREE.MeshBasicMaterial({
            color: '#7890a1',
            side: THREE.BackSide,
            fog: false,
          }),
        );
        scene.add(sky);

        const cloudTexture = await new THREE.TextureLoader().loadAsync(
          `${import.meta.env.BASE_URL}textures/cloud-layer.png`,
        );
        cloudTexture.colorSpace = THREE.SRGBColorSpace;
        cloudTexture.wrapS = THREE.RepeatWrapping;
        cloudTexture.wrapT = THREE.RepeatWrapping;
        cloudTexture.repeat.set(3.2, 1.6);
        cloudTexture.premultiplyAlpha = true;

        const distantCloudTexture = cloudTexture.clone();
        distantCloudTexture.repeat.set(4.6, 2.3);
        distantCloudTexture.offset.set(0.31, 0.17);
        distantCloudTexture.needsUpdate = true;

        const cloudGeometry = new THREE.SphereGeometry(
          122_000,
          48,
          20,
          0,
          Math.PI * 2,
          0,
          Math.PI * 0.53,
        );
        const cloudLayer = new THREE.Mesh(
          cloudGeometry,
          new THREE.MeshBasicMaterial({
            map: cloudTexture,
            color: '#e6edf1',
            side: THREE.BackSide,
            transparent: true,
            opacity: 0.42,
            alphaTest: 0.015,
            depthWrite: false,
            fog: false,
          }),
        );
        const distantCloudLayer = new THREE.Mesh(
          cloudGeometry.clone(),
          new THREE.MeshBasicMaterial({
            map: distantCloudTexture,
            color: '#c5d1d9',
            side: THREE.BackSide,
            transparent: true,
            opacity: 0.22,
            alphaTest: 0.01,
            depthWrite: false,
            fog: false,
          }),
        );
        distantCloudLayer.scale.setScalar(0.92);
        distantCloudLayer.rotation.y = 1.1;
        scene.add(cloudLayer, distantCloudLayer);

        scene.add(new THREE.AmbientLight('#a9bdc8', 1.05));
        scene.add(new THREE.HemisphereLight('#e5f0f4', '#4a5552', 1.75));
        const sun = new THREE.DirectionalLight('#fff0d5', 1.45);
        sun.position.set(-22_000, 32_000, -18_000);
        scene.add(sun);
        const valleyFill = new THREE.DirectionalLight('#a9c7d6', 0.68);
        valleyFill.position.set(26_000, 16_000, 22_000);
        scene.add(valleyFill);

        cleanupListeners.push(() => {
          cloudTexture.dispose();
          distantCloudTexture.dispose();
          (sky.material as ThreeTypes.Material).dispose();
          (cloudLayer.material as ThreeTypes.Material).dispose();
          (distantCloudLayer.material as ThreeTypes.Material).dispose();
        });

        const terrain = new THREE.Group();
        terrain.scale.set(1, exaggerationRef.current, 1);
        terrainRef.current = terrain;
        scene.add(terrain);
        const horizonTerrain = new THREE.Group();
        horizonTerrain.name = 'ultra-low-detail-horizon';
        terrain.add(horizonTerrain);
        const annotationLayer = new THREE.Group();
        annotationLayer.name = 'terrain-annotations';
        terrain.add(annotationLayer);

        const centerTile = lonLatToTile(
          center.longitude,
          center.latitude,
          ZOOM,
        );
        const tileMeterSize =
          (Math.cos((center.latitude * Math.PI) / 180) *
            2 *
            Math.PI *
            EARTH_RADIUS) /
          2 ** ZOOM;
        const tileX = Math.floor(centerTile.x);
        const tileY = Math.floor(centerTile.y);
        type TerrainLod = 'near' | 'mid' | 'far' | 'ultra';
        type TerrainCoordinate = {
          x: number;
          y: number;
          lod: TerrainLod;
        };
        const getTerrainLod = (
          x: number,
          y: number,
          cameraPosition: ThreeTypes.Vector3,
          currentLod?: TerrainLod,
        ): TerrainLod => {
          const tileCenterX = (x + 0.5 - centerTile.x) * tileMeterSize;
          const tileCenterZ = (y + 0.5 - centerTile.y) * tileMeterSize;
          const cameraDistance = Math.max(
            tileMeterSize * 0.35,
            Math.hypot(
              tileCenterX - cameraPosition.x,
              1_500 - cameraPosition.y,
              tileCenterZ - cameraPosition.z,
            ),
          );
          const viewportHeight = Math.max(
            mountRef.current?.clientHeight ?? 900,
            1,
          );
          const projectedPixels =
            (tileMeterSize * viewportHeight) /
            (2 * cameraDistance * Math.tan(THREE.MathUtils.degToRad(23)));

          // Wider enter/leave thresholds prevent a tile from rebuilding on
          // every small camera movement near an LOD boundary.
          if (
            currentLod === 'near' &&
            projectedPixels >= LOD_NEAR_HYSTERESIS_PIXELS
          ) {
            return 'near';
          }
          if (
            currentLod === 'mid' &&
            projectedPixels >= LOD_MID_HYSTERESIS_PIXELS &&
            projectedPixels < LOD_NEAR_PIXELS * 1.2
          ) {
            return 'mid';
          }
          if (
            currentLod === 'far' &&
            projectedPixels >= LOD_FAR_HYSTERESIS_PIXELS &&
            projectedPixels < LOD_MID_PIXELS * 1.25
          ) {
            return 'far';
          }
          if (
            currentLod === 'ultra' &&
            projectedPixels < LOD_FAR_PIXELS * 1.35
          ) {
            return 'ultra';
          }
          return projectedPixels >= LOD_NEAR_PIXELS
            ? 'near'
            : projectedPixels >= LOD_MID_PIXELS
              ? 'mid'
              : projectedPixels >= LOD_FAR_PIXELS
                ? 'far'
                : 'ultra';
        };
        const getLodSegments = (lod: TerrainLod) => {
          if (lod === 'near') return highDetail ? 255 : 127;
          if (lod === 'mid') return highDetail ? 95 : 63;
          if (lod === 'far') return 31;
          return 15;
        };
        const getMapZoomOffset = (lod: TerrainLod) =>
          lod === 'near'
            ? GOOGLE_MAP_NEAR_ZOOM_OFFSET
            : lod === 'mid'
              ? GOOGLE_MAP_MID_ZOOM_OFFSET
              : lod === 'far'
                ? GOOGLE_MAP_FAR_ZOOM_OFFSET
                : GOOGLE_MAP_ULTRA_ZOOM_OFFSET;
        const getStreamCoordinates = (
          focusX: number,
          focusY: number,
          cameraPosition: ThreeTypes.Vector3,
          currentRecords?: ReadonlyMap<string, { lod: TerrainLod }>,
        ) => {
          const coordinates: TerrainCoordinate[] = [];
          for (let row = -FAR_TILE_RADIUS; row <= FAR_TILE_RADIUS; row += 1) {
            for (
              let column = -FAR_TILE_RADIUS;
              column <= FAR_TILE_RADIUS;
              column += 1
            ) {
              const x = focusX + column;
              const y = focusY + row;
              coordinates.push({
                x,
                y,
                lod: getTerrainLod(
                  x,
                  y,
                  cameraPosition,
                  currentRecords?.get(`${x}/${y}`)?.lod,
                ),
              });
            }
          }
          return coordinates.sort((a, b) => {
            const lodPriority = {
              near: 0,
              mid: 1,
              far: 2,
              ultra: 3,
            } as const;
            return (
              lodPriority[a.lod] - lodPriority[b.lod] ||
              Math.max(Math.abs(a.x - focusX), Math.abs(a.y - focusY)) -
                Math.max(Math.abs(b.x - focusX), Math.abs(b.y - focusY))
            );
          });
        };
        const initialCameraPosition = new THREE.Vector3(
          0,
          1_100 + Math.sin(0.42) * 16_000,
          Math.cos(0.42) * 16_000,
        );
        const initialCoordinates = getStreamCoordinates(
          tileX,
          tileY,
          initialCameraPosition,
        ).filter(
          ({ x, y }) =>
            Math.max(Math.abs(x - tileX), Math.abs(y - tileY)) <=
            NEAR_TILE_RADIUS,
        );

        // 255 intervals line up with the 256px Terrarium source, preserving
        // every available elevation sample without inventing extra detail.
        const tempColor = new THREE.Color();
        const colorStops = COLOR_STOPS.map(({ h, hex }) => ({
          h,
          c: new THREE.Color(hex),
        }));

        setLoading('LOADING ELEVATION DATA');
        const terrainTiles: TileData[] = [];
        for (let start = 0; start < initialCoordinates.length; start += 3) {
          const batch = await Promise.all(
            initialCoordinates.slice(start, start + 3).map(async ({ x, y }) => {
              try {
                return await loadTile(x, y);
              } catch (error) {
                console.warn(error);
                return null;
              }
            }),
          );
          terrainTiles.push(
            ...batch.filter((tile): tile is TileData => tile !== null),
          );
        }

        if (terrainTiles.length === 0) {
          throw new Error('无法读取高程瓦片，请检查网络后重试。');
        }

        const tileLookup = new Map(
          terrainTiles.map((tile) => [`${tile.x}/${tile.y}`, tile] as const),
        );
        const sampleElevation = (
          worldTileX: number,
          worldTileY: number,
          fallback: TileData,
        ) => {
          const sourceX = Math.floor(worldTileX);
          const sourceY = Math.floor(worldTileY);
          const source = tileLookup.get(`${sourceX}/${sourceY}`) ?? fallback;
          const localX =
            source === fallback && sourceX !== fallback.x
              ? worldTileX < fallback.x
                ? 0
                : 1
              : worldTileX - sourceX;
          const localY =
            source === fallback && sourceY !== fallback.y
              ? worldTileY < fallback.y
                ? 0
                : 1
              : worldTileY - sourceY;
          const pixelX = Math.max(
            0,
            Math.min(source.width - 1, Math.round(localX * (source.width - 1))),
          );
          const pixelY = Math.max(
            0,
            Math.min(
              source.height - 1,
              Math.round(localY * (source.height - 1)),
            ),
          );
          return decodeElevation(source.pixels, pixelY * source.width + pixelX);
        };

        type TerrainTileRecord = {
          mesh: ThreeTypes.Mesh;
          material: ThreeTypes.MeshStandardMaterial;
          texture: ThreeTypes.Texture | null;
          provider: MapProvider;
          lod: TerrainLod;
          triangles: number;
        };
        const terrainTileRecords = new Map<string, TerrainTileRecord>();
        const updateTerrainStats = () => {
          const records = Array.from(terrainTileRecords.values());
          statsRef.current.loadedTiles = records.length;
          statsRef.current.loadedMapTiles = records.filter(
            ({ texture }) => texture !== null,
          ).length;
          statsRef.current.mapProvider = records.some(
            ({ provider }) => provider === 'GOOGLE',
          )
            ? 'GOOGLE'
            : records.some(({ provider }) => provider === 'OPENTOPO')
              ? 'OPENTOPO'
              : 'NONE';
          statsRef.current.triangles = records.reduce(
            (total, { triangles }) => total + triangles,
            0,
          );
          statsRef.current.totalTiles = TILE_COUNT;
          onStats({ ...statsRef.current });
        };

        const disposeTerrainTile = (key: string) => {
          const record = terrainTileRecords.get(key);
          if (!record) return;
          record.mesh.removeFromParent();
          record.mesh.geometry.dispose();
          record.material.dispose();
          record.texture?.dispose();
          const materialIndex = materialRefs.current.findIndex(
            ({ material }) => material === record.material,
          );
          if (materialIndex >= 0) materialRefs.current.splice(materialIndex, 1);
          terrainTileRecords.delete(key);
        };

        const pruneTerrainTiles = (
          desiredKeys: Set<string>,
          focusX: number,
          focusY: number,
        ) => {
          terrainTileRecords.forEach((_record, key) => {
            if (!desiredKeys.has(key)) disposeTerrainTile(key);
          });
          tileLookup.forEach((tile, key) => {
            if (
              Math.max(Math.abs(tile.x - focusX), Math.abs(tile.y - focusY)) >
              FAR_TILE_RADIUS + 1
            ) {
              tileLookup.delete(key);
            }
          });
          updateTerrainStats();
        };

        const buildTerrainTiles = async (
          tilesToBuild: TileData[],
          showBlockingLoading: boolean,
          desiredLods: ReadonlyMap<string, TerrainLod>,
        ) => {
          for (let start = 0; start < tilesToBuild.length; start += 3) {
            const tiles = await Promise.all(
              tilesToBuild.slice(start, start + 3).map(async (tile) => {
                const key = `${tile.x}/${tile.y}`;
                const lod = desiredLods.get(key) ?? 'far';
                if (terrainTileRecords.get(key)?.lod === lod) {
                  return { tile, lod, mapBlob: null, skip: true } as const;
                }
                return {
                  tile,
                  lod,
                  mapBlob: await loadMapTile(
                    tile.x,
                    tile.y,
                    getMapZoomOffset(lod),
                    ZOOM,
                    mapSource,
                    center.latitude,
                    center.longitude,
                  ).catch((error) => {
                    console.warn(error);
                    return null;
                  }),
                  skip: false,
                } as const;
              }),
            );
            if (disposed) return;

            for (const loaded of tiles) {
              const { tile, lod, mapBlob, skip } = loaded;
              const key = `${tile.x}/${tile.y}`;
              if (skip || terrainTileRecords.get(key)?.lod === lod) {
                continue;
              }
              const segments = getLodSegments(lod);
              const vertexCount = (segments + 1) ** 2;
              const positions = new Float32Array(vertexCount * 3);
              const normals = new Float32Array(vertexCount * 3);
              const colors = new Float32Array(vertexCount * 3);
              const uvs = new Float32Array(vertexCount * 2);
              const indices = new Uint32Array(segments * segments * 6);
              const sampleStep = 1 / segments;
              const normalRun = tileMeterSize * sampleStep * 2;

              for (let row = 0; row <= segments; row += 1) {
                for (let column = 0; column <= segments; column += 1) {
                  const u = column / segments;
                  const v = row / segments;
                  const worldTileX = tile.x + u;
                  const worldTileY = tile.y + v;
                  const elevation = sampleElevation(
                    worldTileX,
                    worldTileY,
                    tile,
                  );
                  const vertex = row * (segments + 1) + column;
                  const offset = vertex * 3;
                  positions[offset] =
                    (worldTileX - centerTile.x) * tileMeterSize;
                  positions[offset + 1] = elevation - BASE_ELEVATION;
                  positions[offset + 2] =
                    (worldTileY - centerTile.y) * tileMeterSize;

                  const normalX =
                    sampleElevation(worldTileX - sampleStep, worldTileY, tile) -
                    sampleElevation(worldTileX + sampleStep, worldTileY, tile);
                  const normalZ =
                    sampleElevation(worldTileX, worldTileY - sampleStep, tile) -
                    sampleElevation(worldTileX, worldTileY + sampleStep, tile);
                  const normalLength = Math.hypot(normalX, normalRun, normalZ);
                  normals[offset] = normalX / normalLength;
                  normals[offset + 1] = normalRun / normalLength;
                  normals[offset + 2] = normalZ / normalLength;

                  heightColor(elevation, tempColor, colorStops);
                  colors[offset] = tempColor.r;
                  colors[offset + 1] = tempColor.g;
                  colors[offset + 2] = tempColor.b;
                  uvs[vertex * 2] = u;
                  uvs[vertex * 2 + 1] = 1 - v;
                }
              }

              let cursor = 0;
              for (let row = 0; row < segments; row += 1) {
                for (let column = 0; column < segments; column += 1) {
                  const a = row * (segments + 1) + column;
                  const b = a + 1;
                  const c = a + segments + 1;
                  const d = c + 1;
                  indices[cursor++] = a;
                  indices[cursor++] = c;
                  indices[cursor++] = b;
                  indices[cursor++] = b;
                  indices[cursor++] = c;
                  indices[cursor++] = d;
                }
              }

              const geometry = new THREE.BufferGeometry();
              geometry.setAttribute(
                'position',
                new THREE.BufferAttribute(positions, 3),
              );
              geometry.setAttribute(
                'color',
                new THREE.BufferAttribute(colors, 3),
              );
              geometry.setAttribute(
                'normal',
                new THREE.BufferAttribute(normals, 3),
              );
              geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
              geometry.setIndex(new THREE.BufferAttribute(indices, 1));
              geometry.computeBoundingSphere();

              let texture: ThreeTypes.Texture | null = null;
              if (mapBlob) {
                const bitmap = await createImageBitmap(mapBlob.blob);
                const mapCanvas = document.createElement('canvas');
                mapCanvas.width = bitmap.width;
                mapCanvas.height = bitmap.height;
                mapCanvas.getContext('2d')?.drawImage(bitmap, 0, 0);
                bitmap.close();
                texture = new THREE.CanvasTexture(mapCanvas);
                texture.colorSpace = THREE.SRGBColorSpace;
                texture.anisotropy = 16;
                texture.minFilter = THREE.LinearMipmapLinearFilter;
                texture.magFilter = THREE.LinearFilter;
                texture.needsUpdate = true;
              }

              const material = new THREE.MeshStandardMaterial({
                map: mapOverlayRef.current ? texture : null,
                vertexColors: !mapOverlayRef.current || !texture,
                roughness: 1,
                metalness: 0,
                wireframe: wireframeRef.current,
              });
              if (terrainTileRecords.has(key)) disposeTerrainTile(key);
              materialRefs.current.push({ material, texture });
              const mesh = new THREE.Mesh(geometry, material);
              terrain.add(mesh);
              terrainTileRecords.set(key, {
                mesh,
                material,
                texture,
                provider: mapBlob?.provider ?? 'NONE',
                lod,
                triangles: segments * segments * 2,
              });
              if (showBlockingLoading) {
                updateTerrainStats();
                setLoading(
                  `LOADING NEAR TERRAIN  ${terrainTileRecords.size} / ${INITIAL_TILE_COUNT}`,
                );
              }

              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve()),
              );
            }
          }
        };

        const initialLods = new Map(
          initialCoordinates.map(({ x, y, lod }) => [`${x}/${y}`, lod]),
        );
        await buildTerrainTiles(terrainTiles, true, initialLods);

        let residentFocusX = tileX;
        let residentFocusY = tileY;
        let residentLodSignature = '';
        let queuedStreamFocus: {
          x: number;
          y: number;
          cameraPosition: ThreeTypes.Vector3;
        } | null = null;
        let streamInProgress = false;

        const getLodSignature = (coordinates: TerrainCoordinate[]) =>
          coordinates
            .map(({ x, y, lod }) => `${x}/${y}:${lod}`)
            .sort()
            .join('|');

        const loadTerrainWindow = async (
          focusX: number,
          focusY: number,
          cameraPosition: ThreeTypes.Vector3,
        ) => {
          const desiredCoordinates = getStreamCoordinates(
            focusX,
            focusY,
            cameraPosition,
            terrainTileRecords,
          );
          const desiredLods = new Map(
            desiredCoordinates.map(({ x, y, lod }) => [`${x}/${y}`, lod]),
          );
          const desiredLodSignature = getLodSignature(desiredCoordinates);
          const desiredKeys = new Set(
            desiredCoordinates.map(({ x, y }) => `${x}/${y}`),
          );
          const missingCoordinates = desiredCoordinates.filter(
            ({ x, y, lod }) => terrainTileRecords.get(`${x}/${y}`)?.lod !== lod,
          );
          if (missingCoordinates.length === 0) {
            pruneTerrainTiles(desiredKeys, focusX, focusY);
            residentLodSignature = desiredLodSignature;
            return true;
          }

          console.info('[terrain] streaming window', {
            focus: `${focusX}/${focusY}`,
            lod: desiredCoordinates.reduce(
              (counts, { lod }) => ({ ...counts, [lod]: counts[lod] + 1 }),
              { near: 0, mid: 0, far: 0, ultra: 0 },
            ),
            missing: missingCoordinates.length,
            resident: terrainTileRecords.size,
          });
          const loaded: TileData[] = [];
          for (let start = 0; start < missingCoordinates.length; start += 3) {
            const batch = await Promise.all(
              missingCoordinates
                .slice(start, start + 3)
                .map(async ({ x, y }) => {
                  try {
                    return (
                      tileLookup.get(`${x}/${y}`) ?? (await loadTile(x, y))
                    );
                  } catch (error) {
                    console.warn('[terrain] streaming DEM failed', {
                      x,
                      y,
                      error,
                    });
                    return null;
                  }
                }),
            );
            const validTiles = batch.filter(
              (tile): tile is TileData => tile !== null,
            );
            validTiles.forEach((tile) =>
              tileLookup.set(`${tile.x}/${tile.y}`, tile),
            );
            loaded.push(...validTiles);
          }

          if (disposed) return false;
          await buildTerrainTiles(loaded, false, desiredLods);
          const complete = desiredCoordinates.every(
            ({ x, y, lod }) => terrainTileRecords.get(`${x}/${y}`)?.lod === lod,
          );
          if (complete) {
            pruneTerrainTiles(desiredKeys, focusX, focusY);
            residentLodSignature = desiredLodSignature;
            console.info('[terrain] streaming window ready', {
              focus: `${focusX}/${focusY}`,
              triangles: statsRef.current.triangles,
              resident: terrainTileRecords.size,
            });
          }
          return complete;
        };

        const requestTerrainWindow = (
          focusX: number,
          focusY: number,
          cameraPosition: ThreeTypes.Vector3,
        ) => {
          queuedStreamFocus = {
            x: focusX,
            y: focusY,
            cameraPosition: cameraPosition.clone(),
          };
          if (streamInProgress) return;
          streamInProgress = true;
          void (async () => {
            while (!disposed && queuedStreamFocus) {
              const next = queuedStreamFocus;
              queuedStreamFocus = null;
              const complete = await loadTerrainWindow(
                next.x,
                next.y,
                next.cameraPosition,
              );
              if (complete) {
                residentFocusX = next.x;
                residentFocusY = next.y;
              }
            }
            streamInProgress = false;
          })().catch((error) => {
            streamInProgress = false;
            console.warn('[terrain] streaming window failed', error);
          });
        };

        type HorizonTileRecord = {
          mesh: ThreeTypes.Mesh;
          material: ThreeTypes.MeshStandardMaterial;
          texture: ThreeTypes.Texture | null;
          segments: number;
        };
        type HorizonCoordinate = {
          x: number;
          y: number;
          zoom: number;
          segments: number;
          mapZoomOffset: number;
          elevationOffset: number;
        };
        const horizonTileRecords = new Map<string, HorizonTileRecord>();
        const horizonTileScale = 2 ** (ZOOM - HORIZON_ZOOM);
        const sampleHorizonElevation = (
          tile: TileData,
          u: number,
          v: number,
        ) => {
          const pixelX = Math.max(
            0,
            Math.min(tile.width - 1, Math.round(u * (tile.width - 1))),
          );
          const pixelY = Math.max(
            0,
            Math.min(tile.height - 1, Math.round(v * (tile.height - 1))),
          );
          return decodeElevation(tile.pixels, pixelY * tile.width + pixelX);
        };
        const disposeHorizonTile = (key: string) => {
          const record = horizonTileRecords.get(key);
          if (!record) return;
          record.mesh.removeFromParent();
          record.mesh.geometry.dispose();
          record.material.dispose();
          record.texture?.dispose();
          const materialIndex = materialRefs.current.findIndex(
            ({ material }) => material === record.material,
          );
          if (materialIndex >= 0) materialRefs.current.splice(materialIndex, 1);
          horizonTileRecords.delete(key);
        };
        const buildHorizonTile = async (
          tile: TileData,
          mapBlob: MapTileData | null,
          coordinate: HorizonCoordinate,
        ) => {
          const { elevationOffset, segments, zoom } = coordinate;
          const tileScale = 2 ** (ZOOM - zoom);
          const vertexCount = (segments + 1) ** 2;
          const positions = new Float32Array(vertexCount * 3);
          const colors = new Float32Array(vertexCount * 3);
          const uvs = new Float32Array(vertexCount * 2);
          const indices = new Uint16Array(segments * segments * 6);

          for (let row = 0; row <= segments; row += 1) {
            for (let column = 0; column <= segments; column += 1) {
              const u = column / segments;
              const v = row / segments;
              const worldTileX = (tile.x + u) * tileScale;
              const worldTileY = (tile.y + v) * tileScale;
              const elevation = sampleHorizonElevation(tile, u, v);
              const vertex = row * (segments + 1) + column;
              const offset = vertex * 3;
              positions[offset] = (worldTileX - centerTile.x) * tileMeterSize;
              positions[offset + 1] =
                elevation - BASE_ELEVATION - elevationOffset;
              positions[offset + 2] =
                (worldTileY - centerTile.y) * tileMeterSize;
              heightColor(elevation, tempColor, colorStops);
              colors[offset] = tempColor.r;
              colors[offset + 1] = tempColor.g;
              colors[offset + 2] = tempColor.b;
              uvs[vertex * 2] = u;
              uvs[vertex * 2 + 1] = 1 - v;
            }
          }

          let cursor = 0;
          for (let row = 0; row < segments; row += 1) {
            for (let column = 0; column < segments; column += 1) {
              const a = row * (segments + 1) + column;
              const b = a + 1;
              const c = a + segments + 1;
              const d = c + 1;
              indices[cursor++] = a;
              indices[cursor++] = c;
              indices[cursor++] = b;
              indices[cursor++] = b;
              indices[cursor++] = c;
              indices[cursor++] = d;
            }
          }

          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute(
            'position',
            new THREE.BufferAttribute(positions, 3),
          );
          geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
          geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
          geometry.setIndex(new THREE.BufferAttribute(indices, 1));
          geometry.computeVertexNormals();
          geometry.computeBoundingSphere();

          let texture: ThreeTypes.Texture | null = null;
          if (mapBlob) {
            const bitmap = await createImageBitmap(mapBlob.blob);
            const mapCanvas = document.createElement('canvas');
            mapCanvas.width = bitmap.width;
            mapCanvas.height = bitmap.height;
            mapCanvas.getContext('2d')?.drawImage(bitmap, 0, 0);
            bitmap.close();
            texture = new THREE.CanvasTexture(mapCanvas);
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.anisotropy = 4;
            texture.minFilter = THREE.LinearMipmapLinearFilter;
            texture.magFilter = THREE.LinearFilter;
            texture.needsUpdate = true;
          }

          const material = new THREE.MeshStandardMaterial({
            map: mapOverlayRef.current ? texture : null,
            vertexColors: !mapOverlayRef.current || !texture,
            roughness: 1,
            metalness: 0,
            wireframe: wireframeRef.current,
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1,
          });
          const key = `${zoom}/${tile.x}/${tile.y}`;
          if (horizonTileRecords.has(key)) disposeHorizonTile(key);
          materialRefs.current.push({ material, texture });
          const mesh = new THREE.Mesh(geometry, material);
          mesh.renderOrder = -1;
          horizonTerrain.add(mesh);
          horizonTileRecords.set(key, { mesh, material, texture, segments });
        };

        let horizonResidentX = Number.NaN;
        let horizonResidentY = Number.NaN;
        let horizonResidentFar = false;
        let queuedHorizonFocus: {
          x: number;
          y: number;
          includeFar: boolean;
        } | null = null;
        let horizonStreamInProgress = false;
        const horizonKey = ({ zoom, x, y }: HorizonCoordinate) =>
          `${zoom}/${x}/${y}`;
        const appendHorizonLayer = (
          desiredCoordinates: HorizonCoordinate[],
          focusX: number,
          focusY: number,
          zoom: number,
          radius: number,
          segments: number,
          mapZoomOffset: number,
          elevationOffset: number,
        ) => {
          const scale = 2 ** (ZOOM - zoom);
          const layerFocusX = Math.floor(focusX / scale);
          const layerFocusY = Math.floor(focusY / scale);
          for (let row = -radius; row <= radius; row += 1) {
            for (let column = -radius; column <= radius; column += 1) {
              desiredCoordinates.push({
                x: layerFocusX + column,
                y: layerFocusY + row,
                zoom,
                segments,
                mapZoomOffset,
                elevationOffset,
              });
            }
          }
        };
        const loadHorizonWindow = async (
          focusX: number,
          focusY: number,
          includeFar: boolean,
        ) => {
          const desiredCoordinates: HorizonCoordinate[] = [];
          appendHorizonLayer(
            desiredCoordinates,
            focusX,
            focusY,
            HORIZON_ZOOM,
            HORIZON_TILE_RADIUS,
            HORIZON_SEGMENTS,
            -1,
            HORIZON_ELEVATION_OFFSET,
          );
          if (includeFar) {
            appendHorizonLayer(
              desiredCoordinates,
              focusX,
              focusY,
              FAR_HORIZON_ZOOM,
              FAR_HORIZON_TILE_RADIUS,
              FAR_HORIZON_SEGMENTS,
              -2,
              HORIZON_ELEVATION_OFFSET + 800,
            );
          }
          desiredCoordinates.sort(
            (a, b) =>
              b.zoom - a.zoom ||
              Math.max(
                Math.abs(a.x - Math.floor(focusX / 2 ** (ZOOM - a.zoom))),
                Math.abs(a.y - Math.floor(focusY / 2 ** (ZOOM - a.zoom))),
              ) -
                Math.max(
                  Math.abs(b.x - Math.floor(focusX / 2 ** (ZOOM - b.zoom))),
                  Math.abs(b.y - Math.floor(focusY / 2 ** (ZOOM - b.zoom))),
                ),
          );
          const desiredKeys = new Set(desiredCoordinates.map(horizonKey));
          const missing = desiredCoordinates.filter(
            (coordinate) => !horizonTileRecords.has(horizonKey(coordinate)),
          );
          console.info('[terrain] horizon fill', {
            focus: `${focusX}/${focusY}`,
            missing: missing.length,
            layers: includeFar ? 'Z10 + Z8 high-altitude' : 'Z10',
          });

          for (let start = 0; start < missing.length; start += 6) {
            const loaded = await Promise.all(
              missing.slice(start, start + 6).map(async (coordinate) => {
                const { mapZoomOffset, x, y, zoom } = coordinate;
                try {
                  const [tile, mapBlob] = await Promise.all([
                    loadTile(x, y, zoom),
                    loadMapTile(
                      x,
                      y,
                      mapZoomOffset,
                      zoom,
                      mapSource,
                      center.latitude,
                      center.longitude,
                    ).catch((error) => {
                      console.warn('[terrain] horizon map failed', {
                        x,
                        y,
                        zoom,
                        error,
                      });
                      return null;
                    }),
                  ]);
                  return { coordinate, tile, mapBlob };
                } catch (error) {
                  console.warn('[terrain] horizon DEM failed', {
                    x,
                    y,
                    zoom,
                    error,
                  });
                  return null;
                }
              }),
            );
            if (disposed) return false;
            for (const item of loaded) {
              if (item)
                await buildHorizonTile(
                  item.tile,
                  item.mapBlob,
                  item.coordinate,
                );
            }
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            );
          }

          if (disposed) return false;
          horizonTileRecords.forEach((_record, key) => {
            if (!desiredKeys.has(key)) disposeHorizonTile(key);
          });
          console.info('[terrain] horizon fill ready', {
            resident: horizonTileRecords.size,
            triangles: Array.from(horizonTileRecords.values()).reduce(
              (total, { segments }) => total + segments * segments * 2,
              0,
            ),
          });
          return desiredCoordinates.every((coordinate) =>
            horizonTileRecords.has(horizonKey(coordinate)),
          );
        };
        const requestHorizonWindow = (
          focusX: number,
          focusY: number,
          includeFar: boolean,
        ) => {
          queuedHorizonFocus = { x: focusX, y: focusY, includeFar };
          if (horizonStreamInProgress) return;
          horizonStreamInProgress = true;
          void (async () => {
            while (!disposed && queuedHorizonFocus) {
              const next = queuedHorizonFocus;
              queuedHorizonFocus = null;
              if (await loadHorizonWindow(next.x, next.y, next.includeFar)) {
                horizonResidentX = Math.floor(next.x / horizonTileScale);
                horizonResidentY = Math.floor(next.y / horizonTileScale);
                horizonResidentFar = next.includeFar;
              }
            }
            horizonStreamInProgress = false;
          })().catch((error) => {
            horizonStreamInProgress = false;
            console.warn('[terrain] horizon streaming failed', error);
          });
        };

        const centerSource =
          tileLookup.get(`${tileX}/${tileY}`) ?? terrainTiles[0];
        const geoPoint = (latitude: number, longitude: number, lift = 0) => {
          const point = lonLatToTile(longitude, latitude, ZOOM);
          return new THREE.Vector3(
            (point.x - centerTile.x) * tileMeterSize,
            sampleElevation(point.x, point.y, centerSource) -
              BASE_ELEVATION +
              lift,
            (point.y - centerTile.y) * tileMeterSize,
          );
        };
        const geoPointAtElevation = (
          latitude: number,
          longitude: number,
          elevation: number,
          lift = 0,
        ) => {
          const point = lonLatToTile(longitude, latitude, ZOOM);
          return new THREE.Vector3(
            (point.x - centerTile.x) * tileMeterSize,
            elevation - BASE_ELEVATION + lift,
            (point.y - centerTile.y) * tileMeterSize,
          );
        };
        // The disaster, route and border overlays below are local reference
        // data. Do not place them into an unrelated terrain view after a
        // coordinate jump.
        const isGyirongScenario =
          Math.hypot(
            (center.latitude - 28.27972) * 111,
            (center.longitude - 85.37778) *
              111 *
              Math.cos((center.latitude * Math.PI) / 180),
          ) < 420;

        const annotationMaterials: ThreeTypes.Material[] = [];
        const annotationTextures: ThreeTypes.Texture[] = [];
        type AnnotationLabelData = {
          baseScale: [number, number];
          baseOffset?: [number, number, number];
          screenScaleDistance?: number;
          maxScale?: number;
        };
        type LabelOptions = {
          titleFontSize?: number;
          subtitleFontSize?: number;
          transparentCard?: boolean;
        };
        const annotationLabels: ThreeTypes.Sprite[] = [];
        type NavigationMarker = {
          group: ThreeTypes.Group;
          maxDistance: number;
          temporarilyRevealed: boolean;
        };
        const navigationMarkers: NavigationMarker[] = [];
        const createLabel = (
          title: string,
          subtitle: string,
          color: string,
          width = 3_500,
          height = 800,
          options: LabelOptions = {},
        ) => {
          const {
            titleFontSize = 44,
            subtitleFontSize = 25,
            transparentCard = false,
          } = options;
          const canvas = document.createElement('canvas');
          canvas.width = 768;
          canvas.height = 176;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Unable to draw terrain annotation');
          if (!transparentCard) {
            context.fillStyle = 'rgba(7, 15, 17, 0.88)';
            context.strokeStyle = color;
            context.lineWidth = 4;
            context.beginPath();
            context.roundRect(4, 4, 760, 168, 24);
            context.fill();
            context.stroke();
          }
          context.fillStyle = color;
          context.fillRect(28, 31, 8, 112);
          context.fillStyle = '#f2f5f3';
          context.font = `600 ${titleFontSize}px sans-serif`;
          context.shadowColor = 'rgba(2, 8, 12, 0.94)';
          context.shadowBlur = transparentCard ? 10 : 0;
          context.shadowOffsetY = transparentCard ? 2 : 0;
          context.fillText(title, 62, transparentCard ? 84 : 73);
          context.fillStyle = '#9fb4af';
          context.font = `500 ${subtitleFontSize}px sans-serif`;
          context.fillText(subtitle, 62, transparentCard ? 136 : 125);
          context.shadowBlur = 0;
          context.shadowOffsetY = 0;
          const texture = new THREE.CanvasTexture(canvas);
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.needsUpdate = true;
          const material = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthTest: false,
            depthWrite: false,
          });
          annotationTextures.push(texture);
          annotationMaterials.push(material);
          const sprite = new THREE.Sprite(material);
          sprite.scale.set(width, height, 1);
          sprite.userData.annotationLabel = {
            baseScale: [width, height],
          } satisfies AnnotationLabelData;
          sprite.renderOrder = 20;
          annotationLabels.push(sprite);
          return sprite;
        };

        const createMarker = ({
          latitude,
          longitude,
          title,
          subtitle,
          color,
          labelOptions,
        }: {
          latitude: number;
          longitude: number;
          title: string;
          subtitle: string;
          color: string;
          labelOptions?: LabelOptions;
        }) => {
          const marker = new THREE.Group();
          marker.position.copy(geoPoint(latitude, longitude, 90));
          const pinMaterial = new THREE.MeshBasicMaterial({ color });
          const ringMaterial = new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.78,
          });
          annotationMaterials.push(pinMaterial, ringMaterial);
          const mast = new THREE.Mesh(
            new THREE.CylinderGeometry(12, 12, 360, 12),
            pinMaterial,
          );
          mast.position.y = 180;
          const point = new THREE.Mesh(
            new THREE.SphereGeometry(52, 20, 12),
            pinMaterial,
          );
          point.position.y = 390;
          const ring = new THREE.Mesh(
            new THREE.TorusGeometry(180, 7, 8, 64),
            ringMaterial,
          );
          ring.rotation.x = Math.PI / 2;
          const label = createLabel(
            title,
            subtitle,
            color,
            3_500,
            800,
            labelOptions,
          );
          label.position.set(1_850, 710, 0);
          (label.userData.annotationLabel as AnnotationLabelData).baseOffset = [
            1_850, 710, 0,
          ];
          marker.add(mast, point, ring, label);
          annotationLayer.add(marker);
          return marker;
        };

        const createNavigationMarker = ({
          latitude,
          longitude,
          elevation,
          title,
          subtitle,
          color,
          maxDistance = 240_000,
        }: {
          latitude: number;
          longitude: number;
          elevation?: number;
          title: string;
          subtitle: string;
          color: string;
          maxDistance?: number;
        }): NavigationMarker => {
          const city = new THREE.Group();
          city.position.copy(
            elevation === undefined
              ? geoPoint(latitude, longitude, 180)
              : geoPointAtElevation(latitude, longitude, elevation, 180),
          );
          const dotMaterial = new THREE.MeshBasicMaterial({
            color,
            depthTest: false,
            depthWrite: false,
          });
          annotationMaterials.push(dotMaterial);
          const dot = new THREE.Mesh(
            new THREE.OctahedronGeometry(52, 0),
            dotMaterial,
          );
          dot.renderOrder = 18;
          const label = createLabel(title, subtitle, color, 5_600, 1_280, {
            titleFontSize: 53,
            subtitleFontSize: 29,
          });
          label.position.set(2_940, 1_080, 0);
          const labelData = label.userData
            .annotationLabel as AnnotationLabelData;
          labelData.baseOffset = [2_940, 1_080, 0];
          // The title glyph is roughly one quarter of the label canvas height.
          // Keep it around 11–12 CSS pixels through the normal scan range.
          labelData.screenScaleDistance = 38_000;
          labelData.maxScale = 9;
          city.add(dot, label);
          annotationLayer.add(city);
          const navigationMarker: NavigationMarker = {
            group: city,
            maxDistance,
            temporarilyRevealed: false,
          };
          navigationMarkers.push(navigationMarker);
          return navigationMarker;
        };

        const marker = createMarker({
          latitude: center.latitude,
          longitude: center.longitude,
          title: isGyirongScenario ? '吉隆口岸' : '当前观测点',
          subtitle: isGyirongScenario
            ? 'Gyirong / Rasuwagadhi · 约 1,850 m'
            : `${center.latitude.toFixed(5)}° N · ${center.longitude.toFixed(5)}° E`,
          color: '#ff8a61',
          labelOptions: {
            titleFontSize: 66,
            subtitleFontSize: 30,
            transparentCard: true,
          },
        });
        if (isGyirongScenario) {
          createMarker({
            latitude: 28.288708,
            longitude: 85.528159,
            title: '岩冰崩塌源区',
            subtitle: '2026-08-26 · 卫星分析初步定位',
            color: '#ff4e45',
          });

          const chinaCityColor = '#f4c27a';
          const chinaMetroColor = '#ffd79a';
          const nepalCityColor = '#72d7cf';
          const waterFeatureColor = '#84dced';
          const landmarkColor = '#d8b4fe';
          [
            {
              latitude: 28.856,
              longitude: 85.297,
              elevation: 2_700,
              title: '吉隆镇 · Gyirong',
              subtitle: '中国 · 西藏',
              color: chinaCityColor,
            },
            {
              latitude: 29.329,
              longitude: 85.233,
              elevation: 4_640,
              title: '萨嘎 · Saga',
              subtitle: '中国 · 西藏',
              color: chinaCityColor,
            },
            {
              latitude: 28.1608,
              longitude: 85.9772,
              elevation: 3_750,
              title: '聂拉木 · Nyalam',
              subtitle: '中国 · 西藏',
              color: chinaCityColor,
            },
            {
              latitude: 27.99,
              longitude: 85.982,
              elevation: 2_300,
              title: '樟木 · Zhangmu',
              subtitle: '中国 · 西藏',
              color: chinaCityColor,
            },
            {
              latitude: 29.267,
              longitude: 88.88,
              elevation: 3_845,
              title: '日喀则 · Shigatse',
              subtitle: '中国 · 西藏',
              color: chinaCityColor,
            },
            {
              latitude: 29.65,
              longitude: 91.12,
              elevation: 3_650,
              title: '拉萨 · Lhasa',
              subtitle: '中国 · 西藏',
              color: chinaCityColor,
            },
            {
              latitude: 29.087,
              longitude: 87.634,
              elevation: 4_050,
              title: '拉孜 · Lhatse',
              subtitle: '中国 · 西藏',
              color: chinaCityColor,
            },
            {
              latitude: 28.661,
              longitude: 87.122,
              elevation: 4_300,
              title: '定日 · Tingri',
              subtitle: '中国 · 西藏',
              color: chinaCityColor,
            },
            {
              latitude: 28.367,
              longitude: 87.772,
              elevation: 4_400,
              title: '定结 · Dinggye',
              subtitle: '中国 · 西藏',
              color: chinaCityColor,
            },
            {
              latitude: 29.298,
              longitude: 87.234,
              elevation: 4_700,
              title: '昂仁 · Ngamring',
              subtitle: '中国 · 西藏',
              color: chinaCityColor,
            },
            {
              latitude: 29.42,
              longitude: 86.724,
              elevation: 4_600,
              title: '桑桑 · Sangsang',
              subtitle: '中国 · 西藏',
              color: chinaCityColor,
            },
            {
              latitude: 31.48,
              longitude: 92.06,
              elevation: 4_500,
              title: '那曲 · Nagqu',
              subtitle: '中国 · 西藏',
              color: chinaCityColor,
            },
            {
              latitude: 29.23,
              longitude: 91.77,
              elevation: 3_560,
              title: '山南 · Shannan',
              subtitle: '中国 · 西藏',
              color: chinaCityColor,
            },
            {
              latitude: 29.66,
              longitude: 94.36,
              elevation: 3_040,
              title: '林芝 · Nyingchi',
              subtitle: '中国 · 西藏',
              color: chinaCityColor,
            },
            {
              latitude: 32.5,
              longitude: 80.1,
              elevation: 4_300,
              title: '狮泉河 · Shiquanhe',
              subtitle: '中国 · 西藏阿里',
              color: chinaCityColor,
            },
            {
              latitude: 30.5728,
              longitude: 104.0668,
              elevation: 500,
              title: '成都 · Chengdu',
              subtitle: '中国 · 四川',
              color: chinaMetroColor,
              maxDistance: 300_000,
            },
            {
              latitude: 29.563,
              longitude: 106.5516,
              elevation: 250,
              title: '重庆 · Chongqing',
              subtitle: '中国 · 直辖市',
              color: chinaMetroColor,
              maxDistance: 300_000,
            },
            {
              latitude: 25.0389,
              longitude: 102.7183,
              elevation: 1_890,
              title: '昆明 · Kunming',
              subtitle: '中国 · 云南',
              color: chinaMetroColor,
              maxDistance: 300_000,
            },
            {
              latitude: 34.3416,
              longitude: 108.9398,
              elevation: 400,
              title: '西安 · Xi’an',
              subtitle: '中国 · 陕西',
              color: chinaMetroColor,
              maxDistance: 300_000,
            },
            {
              latitude: 39.9042,
              longitude: 116.4074,
              elevation: 43,
              title: '北京 · Beijing',
              subtitle: '中国 · 首都',
              color: chinaMetroColor,
              maxDistance: 300_000,
            },
            {
              latitude: 31.2304,
              longitude: 121.4737,
              elevation: 4,
              title: '上海 · Shanghai',
              subtitle: '中国 · 直辖市',
              color: chinaMetroColor,
              maxDistance: 300_000,
            },
            {
              latitude: 30.72,
              longitude: 90.61,
              elevation: 4_718,
              title: '纳木错 · Namtso',
              subtitle: '湖泊 · 西藏',
              color: waterFeatureColor,
            },
            {
              latitude: 28.98,
              longitude: 90.74,
              elevation: 4_441,
              title: '羊卓雍错 · Yamdrok',
              subtitle: '湖泊 · 西藏',
              color: waterFeatureColor,
            },
            {
              latitude: 30.66,
              longitude: 81.47,
              elevation: 4_590,
              title: '玛旁雍错 · Manasarovar',
              subtitle: '湖泊 · 西藏阿里',
              color: waterFeatureColor,
            },
            {
              latitude: 33.7,
              longitude: 78.75,
              elevation: 4_350,
              title: '班公错 · Pangong Tso',
              subtitle: '湖泊 · 阿里',
              color: waterFeatureColor,
            },
            {
              latitude: 36.9425,
              longitude: 100.2222,
              elevation: 3_205,
              title: '青海湖 · Qinghai Lake',
              subtitle: '湖泊 · 青海',
              color: waterFeatureColor,
              maxDistance: 300_000,
            },
            {
              latitude: 29.04,
              longitude: 116.35,
              elevation: 15,
              title: '鄱阳湖 · Poyang Lake',
              subtitle: '湖泊 · 江西',
              color: waterFeatureColor,
              maxDistance: 300_000,
            },
            {
              latitude: 28.83,
              longitude: 112.66,
              elevation: 35,
              title: '洞庭湖 · Dongting Lake',
              subtitle: '湖泊 · 湖南',
              color: waterFeatureColor,
              maxDistance: 300_000,
            },
            {
              latitude: 29.65,
              longitude: 91.12,
              elevation: 3_650,
              title: '雅鲁藏布江 · Yarlung Tsangpo',
              subtitle: '河流 · 拉萨河段',
              color: waterFeatureColor,
            },
            {
              latitude: 29.72,
              longitude: 94.9,
              elevation: 1_700,
              title: '雅鲁藏布大峡谷',
              subtitle: '河流地标 · 西藏',
              color: waterFeatureColor,
            },
            {
              latitude: 29.563,
              longitude: 106.5516,
              elevation: 250,
              title: '长江 · Yangtze',
              subtitle: '河流 · 重庆段',
              color: waterFeatureColor,
              maxDistance: 300_000,
            },
            {
              latitude: 36.06,
              longitude: 103.83,
              elevation: 1_520,
              title: '黄河 · Yellow River',
              subtitle: '河流 · 兰州段',
              color: waterFeatureColor,
              maxDistance: 300_000,
            },
            {
              latitude: 27.9881,
              longitude: 86.925,
              elevation: 8_849,
              title: '珠穆朗玛峰 · Everest',
              subtitle: '高原地标 · 中尼边界',
              color: landmarkColor,
            },
            {
              latitude: 28.1128,
              longitude: 85.2961,
              elevation: 1_967,
              title: '顿切 · Dhunche',
              subtitle: '尼泊尔 · Rasuwa',
              color: nepalCityColor,
            },
            {
              latitude: 27.89,
              longitude: 85.1597,
              elevation: 615,
              title: '比杜尔 · Bidur',
              subtitle: '尼泊尔 · Nuwakot',
              color: nepalCityColor,
            },
            {
              latitude: 27.7083,
              longitude: 85.3206,
              elevation: 1_400,
              title: '加德满都 · Kathmandu',
              subtitle: '尼泊尔首都',
              color: nepalCityColor,
            },
            {
              latitude: 28.2096,
              longitude: 83.9856,
              elevation: 822,
              title: '博克拉 · Pokhara',
              subtitle: '尼泊尔 · Gandaki',
              color: nepalCityColor,
            },
            {
              latitude: 27.6803,
              longitude: 84.4365,
              elevation: 208,
              title: '巴拉特普尔 · Bharatpur',
              subtitle: '尼泊尔 · Chitwan',
              color: nepalCityColor,
            },
          ].forEach(createNavigationMarker);

          // Main overland corridor used for route orientation: the G318 Sichuan–
          // Tibet south line to Lhasa / Shigatse, then the G349–G216 approach to
          // Gyirong. This is a key-place schematic, rather than road-centerline
          // survey data, so it remains legible across the streamed terrain.
          const sichuanToGyirongRoute = [
            [30.5728, 104.0668, 500, '成都 · Chengdu'],
            [29.98, 103.01, 600, '雅安 · Ya’an'],
            [30.05, 101.96, 2_600, '康定 · Kangding'],
            [30.03, 101.5, 3_460, '新都桥 · Xinduqiao'],
            [30.03, 101.01, 2_600, '雅江 · Yajiang'],
            [29.99, 100.27, 4_014, '理塘 · Litang'],
            [30.0, 99.11, 2_580, '巴塘 · Batang'],
            [29.68, 98.59, 3_870, '芒康 · Mangkang'],
            [29.67, 97.84, 3_780, '左贡 · Zuogong'],
            [30.56, 97.34, 4_120, '邦达 · Bangda'],
            [30.05, 96.92, 3_280, '八宿 · Basu'],
            [29.45, 96.75, 3_850, '然乌 · Rawu'],
            [29.86, 95.77, 2_750, '波密 · Bomi'],
            [29.95, 94.73, 3_320, '鲁朗 · Lulang'],
            [29.65, 94.36, 3_040, '林芝 · Nyingchi'],
            [29.88, 93.25, 3_500, '工布江达 · Gongbo’gyamda'],
            [29.83, 91.73, 3_850, '墨竹工卡 · Maizhokunggar'],
            [29.65, 91.12, 3_650, '拉萨 · Lhasa'],
            [29.35, 90.74, 3_600, '曲水 · Qushui'],
            [29.267, 88.88, 3_845, '日喀则 · Shigatse'],
            [29.087, 87.634, 4_050, '拉孜 · Lhatse'],
            [29.02, 86.65, 4_550, 'G349 / G216 转向'],
            [29.329, 85.233, 4_640, '萨嘎 · Saga'],
            [28.856, 85.297, 2_700, '吉隆镇 · Gyirong'],
            [28.27972, 85.37778, 1_850, '吉隆口岸'],
          ] as const;
          const routeColor = '#c9a4ff';
          const routePoints = sichuanToGyirongRoute.map(
            ([latitude, longitude, elevation]) =>
              geoPointAtElevation(latitude, longitude, elevation, 150),
          );
          const routeCurve = new THREE.CatmullRomCurve3(
            routePoints,
            false,
            'centripetal',
          );
          const routeMaterial = new THREE.MeshBasicMaterial({
            color: routeColor,
            transparent: true,
            opacity: 0.76,
            depthWrite: false,
          });
          annotationMaterials.push(routeMaterial);
          const routeRibbon = new THREE.Mesh(
            new THREE.TubeGeometry(routeCurve, 720, 95, 7, false),
            routeMaterial,
          );
          routeRibbon.renderOrder = 7;
          annotationLayer.add(routeRibbon);
          const routeWaypointIndexes = new Set([
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 18, 21,
          ]);
          sichuanToGyirongRoute.forEach(
            ([latitude, longitude, elevation, title], index) => {
              if (!routeWaypointIndexes.has(index)) return;
              createNavigationMarker({
                latitude,
                longitude,
                elevation,
                title,
                subtitle:
                  index <= 20
                    ? 'G318 川藏南线 · 成都 → 拉萨 / 日喀则'
                    : 'G349 → G216 · 日喀则 → 吉隆口岸',
                color: routeColor,
                maxDistance: 180_000,
              });
            },
          );

          // 2026-08-26 source point follows the HiRISK rapid assessment. The
          // corridor follows the connected OSM waterway graph through Chhochen
          // Khola, Lende Khola and downstream into Nepal's Bhote Koshi. It is an
          // orientation aid, not a surveyed inundation boundary.
          const floodRouteCoordinates = [
            [28.296368, 85.508783],
            [28.298115, 85.507713],
            [28.299632, 85.506573],
            [28.301039, 85.505546],
            [28.302454, 85.504346],
            [28.305964, 85.501719],
            [28.307738, 85.499765],
            [28.312362, 85.496308],
            [28.313639, 85.49365],
            [28.316827, 85.489295],
            [28.318899, 85.487844],
            [28.321287, 85.48831],
            [28.324661, 85.485808],
            [28.327203, 85.484638],
            [28.329354, 85.485037],
            [28.331059, 85.485687],
            [28.332937, 85.484339],
            [28.333008, 85.481588],
            [28.333131, 85.479882],
            [28.33301, 85.477478],
            [28.33323, 85.47537],
            [28.333794, 85.473897],
            [28.333818, 85.472246],
            [28.334289, 85.469916],
            [28.335413, 85.466437],
            [28.335856, 85.464337],
            [28.336622, 85.460929],
            [28.33682, 85.458506],
            [28.336373, 85.456989],
            [28.336056, 85.45431],
            [28.33512, 85.449938],
            [28.335554, 85.444362],
            [28.335269, 85.438218],
            [28.333635, 85.434674],
            [28.331944, 85.433215],
            [28.330372, 85.430691],
            [28.330472, 85.425733],
            [28.329259, 85.420362],
            [28.327052, 85.416923],
            [28.326511, 85.414594],
            [28.322635, 85.413289],
            [28.31916, 85.413961],
            [28.316884, 85.414377],
            [28.311115, 85.412949],
            [28.308276, 85.411939],
            [28.307021, 85.40915],
            [28.305478, 85.408593],
            [28.304534, 85.406891],
            [28.301496, 85.403576],
            [28.300754, 85.401773],
            [28.299136, 85.399567],
            [28.297441, 85.397377],
            [28.295017, 85.397296],
            [28.291933, 85.394529],
            [28.288701, 85.391775],
            [28.285951, 85.386986],
            [28.282743, 85.383533],
            [28.281687, 85.38141],
            [28.280374, 85.380776],
            [28.279744, 85.379659],
            [28.279441, 85.378955],
            [28.279029, 85.378506],
            [28.278514, 85.377759],
            [28.278055, 85.376979],
            [28.2779066, 85.3768216],
            [28.2751452, 85.3773933],
            [28.2713134, 85.3776048],
            [28.2682701, 85.376239],
            [28.266605, 85.3755782],
            [28.2655288, 85.3738543],
            [28.2637686, 85.3725293],
            [28.2617948, 85.371794],
            [28.2595682, 85.369335],
            [28.2581913, 85.3658447],
            [28.2542095, 85.3650429],
            [28.2514446, 85.3646775],
            [28.2494292, 85.3648616],
            [28.2463895, 85.3629994],
            [28.2434913, 85.3588736],
            [28.2406879, 85.3582245],
            [28.2380123, 85.3580332],
            [28.2368124, 85.3585944],
            [28.2351725, 85.3590113],
            [28.2334183, 85.360057],
            [28.23082, 85.3605317],
            [28.2285227, 85.361031],
            [28.2258924, 85.3610873],
            [28.2237594, 85.3609334],
            [28.222457, 85.360536],
            [28.2213028, 85.3593171],
            [28.2205331, 85.3584718],
            [28.2190907, 85.3571874],
            [28.2177415, 85.3557745],
            [28.216323, 85.3548749],
            [28.2152425, 85.3546433],
            [28.212834, 85.3547822],
            [28.2107702, 85.3541709],
            [28.2092868, 85.354186],
            [28.2075826, 85.3545052],
            [28.2060722, 85.3548431],
            [28.2047532, 85.3538936],
            [28.2023396, 85.352985],
            [28.1980166, 85.3518202],
            [28.1968721, 85.350757],
            [28.1919014, 85.3488563],
            [28.1874569, 85.3459219],
            [28.1836371, 85.3439246],
            [28.1820751, 85.3434173],
            [28.1811583, 85.3427556],
            [28.1807772, 85.3426722],
            [28.1789346, 85.3428027],
            [28.1769611, 85.3427835],
            [28.1743452, 85.3429465],
            [28.17265, 85.3427098],
            [28.1703673, 85.3427419],
            [28.1681469, 85.3424312],
            [28.1669935, 85.3427899],
            [28.1657707, 85.342693],
            [28.1645234, 85.3415572],
            [28.1644225, 85.3413057],
          ] as const;
          const floodRoutePoints = floodRouteCoordinates.map(
            ([latitude, longitude]) => geoPoint(latitude, longitude, 82),
          );
          const floodRoute = new THREE.CatmullRomCurve3(
            floodRoutePoints,
            false,
            'centripetal',
          );
          const floodMaterial = new THREE.MeshBasicMaterial({
            color: '#44d2e5',
            transparent: true,
            opacity: 0.4,
            depthWrite: false,
          });
          annotationMaterials.push(floodMaterial);
          const floodCorridor = new THREE.Mesh(
            new THREE.TubeGeometry(floodRoute, 260, 55, 8, false),
            floodMaterial,
          );
          floodCorridor.renderOrder = 8;
          annotationLayer.add(floodCorridor);
          createMarker({
            latitude: 28.330372,
            longitude: 85.430691,
            title: '山洪 / 泥石流通道',
            subtitle: '错坚河 → 东林藏布 → 吉隆口岸（OSM 河道）',
            color: '#44d2e5',
          });
          createMarker({
            latitude: 28.2542095,
            longitude: 85.3650429,
            title: '尼泊尔下游洪水通道',
            subtitle: 'Timure → Syabrubesi · Bhote Koshi（OSM）',
            color: '#72dfe9',
          });

          const buildBorderLineGeometry = (
            parts: ReadonlyArray<
              ReadonlyArray<readonly [latitude: number, longitude: number]>
            >,
            elevation: number,
          ) => {
            const positions: number[] = [];
            parts.forEach((part) => {
              if (part.length < 2) return;
              const points = part.map(([latitude, longitude]) =>
                geoPointAtElevation(latitude, longitude, elevation),
              );
              for (let index = 0; index < points.length - 1; index += 1) {
                const start = points[index];
                const end = points[index + 1];
                positions.push(start.x, start.y, start.z, end.x, end.y, end.z);
              }
            });
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute(
              'position',
              new THREE.Float32BufferAttribute(positions, 3),
            );
            geometry.computeBoundingSphere();
            return geometry;
          };
          const createGlobalBorder = (
            parts: ReadonlyArray<
              ReadonlyArray<readonly [latitude: number, longitude: number]>
            >,
            elevation: number,
            color: string,
          ) => {
            const material = new THREE.LineBasicMaterial({
              color,
              transparent: true,
              opacity: 0.78,
              depthTest: true,
              depthWrite: false,
            });
            annotationMaterials.push(material);
            const border = new THREE.LineSegments(
              buildBorderLineGeometry(parts, elevation),
              material,
            );
            border.renderOrder = 10;
            annotationLayer.add(border);
          };

          createGlobalBorder(CHINA_NEPAL_BORDER_PARTS, 4_750, '#ffe2a8');
          createGlobalBorder(CHINA_INDIA_BORDER_PARTS, 4_650, '#ffb982');

          // Local China–Nepal international boundary from connected OSM
          // administrative-boundary ways around Gyirong. This native line adds
          // local precision on top of the broader Natural Earth navigation band.
          const internationalBorderCoordinates = [
            [28.2911553, 85.3473322],
            [28.2899694, 85.3472303],
            [28.288337, 85.3481975],
            [28.2868345, 85.3506518],
            [28.2865424, 85.3521363],
            [28.2865868, 85.3533064],
            [28.2868717, 85.3549141],
            [28.2865525, 85.3565325],
            [28.2859602, 85.3583377],
            [28.2858281, 85.3599856],
            [28.2855184, 85.3623905],
            [28.2857316, 85.3642369],
            [28.2859048, 85.3672808],
            [28.2856873, 85.3697966],
            [28.2849661, 85.371323],
            [28.2834503, 85.3738812],
            [28.2823011, 85.3754643],
            [28.2795707, 85.3769479],
            [28.2781089, 85.3770174],
            [28.2780384, 85.3769757],
            [28.2779285, 85.3771953],
            [28.2802577, 85.3804565],
            [28.2817185, 85.3823387],
            [28.2838149, 85.3851719],
            [28.2851686, 85.3866034],
            [28.2868759, 85.3880944],
            [28.287998, 85.3917811],
            [28.2908885, 85.3938028],
            [28.2929788, 85.3957868],
            [28.2951474, 85.3972292],
            [28.2976124, 85.3972011],
            [28.2984797, 85.397788],
            [28.2990879, 85.3997158],
            [28.29996, 85.4006912],
            [28.300871, 85.4021112],
            [28.3032536, 85.405859],
            [28.3055904, 85.4083784],
            [28.3072319, 85.4101048],
            [28.3083373, 85.4116351],
            [28.3103062, 85.4126287],
            [28.3130093, 85.4134922],
            [28.3157895, 85.4137099],
            [28.3184721, 85.4139921],
            [28.3225268, 85.413185],
            [28.325355, 85.4136884],
            [28.3267135, 85.414622],
            [28.3270196, 85.4150428],
            [28.3272626, 85.4154737],
            [28.32725, 85.4166907],
            [28.3278978, 85.4187828],
            [28.3293206, 85.4210003],
            [28.3297494, 85.4231498],
            [28.3301916, 85.427734],
            [28.3300767, 85.4299093],
            [28.3306945, 85.4311402],
            [28.3329601, 85.4339561],
            [28.334331, 85.436064],
            [28.3350361, 85.4386726],
            [28.3351329, 85.4419199],
            [28.3350166, 85.4464968],
            [28.3349317, 85.4503833],
            [28.3351949, 85.4525582],
            [28.3357816, 85.4539535],
            [28.3360773, 85.456255],
            [28.3365322, 85.4586354],
            [28.336116, 85.4608066],
            [28.3358581, 85.4635995],
            [28.3350606, 85.4664631],
            [28.3341679, 85.4696461],
            [28.3336793, 85.472666],
            [28.33329, 85.4745467],
            [28.3329719, 85.4779032],
            [28.3331249, 85.4799177],
            [28.3329546, 85.4817356],
            [28.3331669, 85.4836523],
            [28.3319678, 85.4854667],
            [28.3310913, 85.4870939],
            [28.3312677, 85.4887138],
            [28.330914, 85.4900083],
            [28.3316548, 85.4920334],
            [28.3322196, 85.4951348],
            [28.3326108, 85.4997303],
            [28.3336982, 85.5020648],
            [28.3337287, 85.5036061],
            [28.3332593, 85.5052352],
            [28.3330187, 85.5069848],
            [28.3324402, 85.5091011],
            [28.3314516, 85.5106626],
            [28.331252, 85.512697],
            [28.3307169, 85.5146169],
            [28.3305435, 85.5178221],
            [28.3300086, 85.5194275],
            [28.3292458, 85.5208174],
            [28.3283, 85.524334],
            [28.3271131, 85.5262742],
            [28.3258301, 85.5288973],
            [28.3246361, 85.5314616],
            [28.3235176, 85.5332985],
            [28.3222827, 85.5354139],
            [28.3210449, 85.5362005],
            [28.3201784, 85.5377053],
            [28.3187184, 85.540765],
            [28.318176, 85.5430624],
            [28.3169173, 85.5446696],
            [28.3151059, 85.5464809],
            [28.3142666, 85.5478972],
            [28.3135331, 85.5505313],
            [28.3130537, 85.5522242],
            [28.3116037, 85.5553692],
            [28.3115774, 85.5554476],
          ] as const;
          const borderGeometry = new THREE.BufferGeometry().setFromPoints(
            internationalBorderCoordinates.map(([latitude, longitude]) =>
              geoPoint(latitude, longitude, 58),
            ),
          );
          const borderMaterial = new THREE.LineBasicMaterial({
            color: '#fff0c9',
            transparent: true,
            opacity: 1,
            depthTest: false,
            depthWrite: false,
          });
          annotationMaterials.push(borderMaterial);
          const internationalBorder = new THREE.Line(
            borderGeometry,
            borderMaterial,
          );
          internationalBorder.renderOrder = 7;
          annotationLayer.add(internationalBorder);

          const borderLabel = createLabel(
            '中国 / 尼泊尔国境线',
            'CHINA / NEPAL BORDER · OSM',
            '#e2d5b9',
            2_700,
            620,
          );
          borderLabel.position.copy(geoPoint(28.3157895, 85.4137099, 520));
          annotationLayer.add(borderLabel);

          const createBorderLabel = (
            title: string,
            subtitle: string,
            latitude: number,
            longitude: number,
            elevation: number,
            color: string,
          ) => {
            const label = createLabel(title, subtitle, color, 2_450, 565);
            label.position.copy(
              geoPointAtElevation(latitude, longitude, elevation, 520),
            );
            (
              label.userData.annotationLabel as AnnotationLabelData
            ).screenScaleDistance = 92_000;
            annotationLayer.add(label);
          };
          createBorderLabel(
            '中国 / 尼泊尔国境线',
            'CHINA / NEPAL · NATURAL EARTH',
            29.72,
            83.55,
            4_750,
            '#ffe2a8',
          );
          createBorderLabel(
            '中国 / 印度国境线',
            'CHINA / INDIA · NATURAL EARTH',
            27.82,
            88.45,
            4_650,
            '#ffb982',
          );
          createBorderLabel(
            '中国 / 印度国境线',
            'CHINA / INDIA · NATURAL EARTH',
            30.43,
            80.45,
            4_650,
            '#ffb982',
          );
        }

        cleanupListeners.push(() => {
          annotationMaterials.forEach((material) => material.dispose());
          annotationTextures.forEach((texture) => texture.dispose());
        });

        const view = {
          yaw: 0,
          pitch: 0.42,
          roll: 0,
          distance: 16_000,
          target: new THREE.Vector3(0, 1_100, 0),
        };

        const resetView = () => {
          view.yaw = 0;
          view.pitch = 0.42;
          view.roll = 0;
          view.distance = 16_000;
          view.target.set(0, 1_100, 0);
        };
        resetRef.current = resetView;

        let placeScanSequence = 0;
        let dynamicPlaceMarkers: NavigationMarker[] = [];
        const clearDynamicPlaceMarkers = () => {
          dynamicPlaceMarkers.forEach(({ group }) => {
            annotationLayer.remove(group);
            const markerIndex = navigationMarkers.findIndex(
              (marker) => marker.group === group,
            );
            if (markerIndex >= 0) navigationMarkers.splice(markerIndex, 1);
          });
          dynamicPlaceMarkers = [];
        };
        const tileToLonLat = (x: number, y: number) => {
          const scale = 2 ** ZOOM;
          const longitude = (x / scale) * 360 - 180;
          const mercatorY = Math.PI - (2 * Math.PI * y) / scale;
          const latitude = (180 / Math.PI) * Math.atan(Math.sinh(mercatorY));
          return { latitude, longitude };
        };
        const loadScannedPlaces = async () => {
          const scanId = ++placeScanSequence;
          const target = tileToLonLat(
            centerTile.x + view.target.x / tileMeterSize,
            centerTile.y + view.target.z / tileMeterSize,
          );
          // Keep the request small enough for Overpass, but expand it when the
          // camera is high so a scan describes the land currently in view.
          const radiusMeters = Math.min(
            55_000,
            Math.max(12_000, view.distance * 0.82),
          );
          const latitudeDelta = radiusMeters / 111_320;
          const longitudeDelta =
            radiusMeters /
            Math.max(
              30_000,
              111_320 * Math.cos((target.latitude * Math.PI) / 180),
            );
          const south = (target.latitude - latitudeDelta).toFixed(5);
          const west = (target.longitude - longitudeDelta).toFixed(5);
          const north = (target.latitude + latitudeDelta).toFixed(5);
          const east = (target.longitude + longitudeDelta).toFixed(5);
          const query = `[out:json][timeout:12];(nwr["place"~"^(city|town|village|hamlet)$"](${south},${west},${north},${east});nwr["natural"~"^(peak|volcano)$"](${south},${west},${north},${east}););out center tags 32;`;

          try {
            const response = await fetch(
              'https://overpass-api.de/api/interpreter',
              {
                method: 'POST',
                headers: {
                  'content-type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({ data: query }),
              },
            );
            if (!response.ok) {
              throw new Error(`OSM place scan failed (${response.status})`);
            }
            const result = (await response.json()) as {
              elements?: Array<{
                lat?: number;
                lon?: number;
                center?: { lat: number; lon: number };
                tags?: Record<string, string | undefined>;
              }>;
            };
            if (disposed || scanId !== placeScanSequence) return;

            const places = (result.elements ?? [])
              .map((element) => {
                const latitude = element.lat ?? element.center?.lat;
                const longitude = element.lon ?? element.center?.lon;
                const tags = element.tags ?? {};
                const name = tags.name ?? tags['name:zh'] ?? tags['name:en'];
                const kind = tags.place ?? tags.natural;
                return { latitude, longitude, name, kind };
              })
              .filter(
                (
                  place,
                ): place is {
                  latitude: number;
                  longitude: number;
                  name: string;
                  kind: string;
                } =>
                  Number.isFinite(place.latitude) &&
                  Number.isFinite(place.longitude) &&
                  Boolean(place.name) &&
                  Boolean(place.kind),
              )
              .sort((left, right) => {
                const priority = (kind: string) =>
                  kind === 'city'
                    ? 0
                    : kind === 'town'
                      ? 1
                      : kind === 'village'
                        ? 2
                        : kind === 'peak'
                          ? 3
                          : 4;
                return priority(left.kind) - priority(right.kind);
              })
              .filter(
                (place, index, all) =>
                  all.findIndex(
                    (candidate) =>
                      candidate.name === place.name &&
                      Math.abs(candidate.latitude - place.latitude) < 0.005 &&
                      Math.abs(candidate.longitude - place.longitude) < 0.005,
                  ) === index,
              )
              .slice(0, 18);

            clearDynamicPlaceMarkers();
            dynamicPlaceMarkers = places.map((place) => {
              const marker = createNavigationMarker({
                latitude: place.latitude,
                longitude: place.longitude,
                title: place.name,
                subtitle: `OSM · ${
                  place.kind === 'city'
                    ? '城市'
                    : place.kind === 'town'
                      ? '城镇'
                      : place.kind === 'village'
                        ? '村庄'
                        : place.kind === 'hamlet'
                          ? '聚落'
                          : '山峰'
                }`,
                color: '#b9e7ed',
                maxDistance: radiusMeters * 2.8,
              });
              marker.temporarilyRevealed = true;
              return marker;
            });
            console.info('[gamepad] Square OSM place scan complete', {
              center: target,
              radiusMeters: Math.round(radiusMeters),
              loaded: dynamicPlaceMarkers.length,
            });
          } catch (error) {
            if (disposed || scanId !== placeScanSequence) return;
            console.warn('[gamepad] Square OSM place scan failed', error);
          }
        };

        const keys = new Set<string>();
        let dragging = false;
        let lastX = 0;
        let lastY = 0;
        let lastInteractionAt = performance.now();
        const noteInteraction = () => {
          lastInteractionAt = performance.now();
        };

        const onPointerDown = (event: PointerEvent) => {
          noteInteraction();
          renderer.domElement.focus();
          dragging = true;
          lastX = event.clientX;
          lastY = event.clientY;
          renderer.domElement.setPointerCapture(event.pointerId);
        };
        const onPointerMove = (event: PointerEvent) => {
          if (!dragging) return;
          noteInteraction();
          view.yaw -= (event.clientX - lastX) * 0.0045;
          view.pitch = Math.max(
            0.08,
            Math.min(1.28, view.pitch + (event.clientY - lastY) * 0.004),
          );
          lastX = event.clientX;
          lastY = event.clientY;
        };
        const onPointerUp = () => {
          noteInteraction();
          dragging = false;
        };
        const onWheel = (event: WheelEvent) => {
          noteInteraction();
          event.preventDefault();
          view.distance = Math.max(
            1_100,
            Math.min(90_000, view.distance * Math.exp(event.deltaY * 0.0008)),
          );
        };
        const onKeyDown = (event: KeyboardEvent) => {
          noteInteraction();
          keys.add(event.code);
        };
        const onKeyUp = (event: KeyboardEvent) => {
          noteInteraction();
          keys.delete(event.code);
        };

        let activeGamepadIndex: number | null = null;
        const gamepadMode = 'DEFAULT' as const;
        let l3WasPressed = false;
        let r3WasPressed = false;
        let squareWasPressed = false;
        let circleWasPressed = false;
        let placeScanRequested = false;
        let annotationsVisible = true;
        let lastGamepadInputLogAt = 0;
        let warnedAboutMapping = false;

        const gamepadName = (gamepad: Gamepad) =>
          gamepad.id
            .replace(/\s+\(.+?\)\s*$/, '')
            .trim()
            .slice(0, 48) || `Gamepad #${gamepad.index}`;

        const activateGamepad = (
          gamepad: Gamepad,
          source: 'event' | 'scan',
        ) => {
          const changed = activeGamepadIndex !== gamepad.index;
          activeGamepadIndex = gamepad.index;
          statsRef.current.gamepad = gamepadName(gamepad);
          statsRef.current.gamepadMode = gamepadMode;
          statsRef.current.gamepadDebug =
            `#${gamepad.index} ${gamepad.mapping || 'raw'} · ` +
            `${gamepad.axes.length} axes / ${gamepad.buttons.length} buttons`;

          if (changed) {
            console.info('[gamepad] active controller', {
              source,
              index: gamepad.index,
              id: gamepad.id,
              mapping: gamepad.mapping || 'raw',
              axes: gamepad.axes.length,
              buttons: gamepad.buttons.length,
            });
            onStats({ ...statsRef.current });
          }
        };

        const findActiveGamepad = () => {
          const gamepads = Array.from(navigator.getGamepads?.() ?? []).filter(
            (gamepad): gamepad is Gamepad => gamepad !== null,
          );
          const active = gamepads.find(
            (gamepad) => gamepad.index === activeGamepadIndex,
          );
          if (active) return active;

          const next = gamepads[0] ?? null;
          if (next) {
            activateGamepad(next, 'scan');
          } else if (activeGamepadIndex !== null) {
            console.warn('[gamepad] active controller disappeared', {
              index: activeGamepadIndex,
            });
            activeGamepadIndex = null;
            statsRef.current.gamepad = null;
            statsRef.current.gamepadMode = null;
            statsRef.current.gamepadDebug = '未检测到手柄，按任意手柄键激活…';
            onStats({ ...statsRef.current });
          }
          return next;
        };

        const onGamepad = (event: GamepadEvent) => {
          console.info('[gamepad] connected event', {
            index: event.gamepad.index,
            id: event.gamepad.id,
            mapping: event.gamepad.mapping || 'raw',
            axes: event.gamepad.axes.length,
            buttons: event.gamepad.buttons.length,
          });
          activateGamepad(event.gamepad, 'event');
        };
        const onGamepadDisconnect = (event: GamepadEvent) => {
          console.info('[gamepad] disconnected event', {
            index: event.gamepad.index,
            id: event.gamepad.id,
          });
          if (event.gamepad.index !== activeGamepadIndex) return;
          activeGamepadIndex = null;
          statsRef.current.gamepad = null;
          statsRef.current.gamepadMode = null;
          statsRef.current.gamepadDebug = '手柄已断开，等待重新连接…';
          onStats({ ...statsRef.current });
        };

        renderer.domElement.addEventListener('pointerdown', onPointerDown);
        renderer.domElement.addEventListener('pointermove', onPointerMove);
        renderer.domElement.addEventListener('pointerup', onPointerUp);
        renderer.domElement.addEventListener('pointercancel', onPointerUp);
        renderer.domElement.addEventListener('wheel', onWheel, {
          passive: false,
        });
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        window.addEventListener('gamepadconnected', onGamepad);
        window.addEventListener('gamepaddisconnected', onGamepadDisconnect);
        console.info('[gamepad] polling ready', {
          apiAvailable: typeof navigator.getGamepads === 'function',
          detectedSlots: navigator.getGamepads?.().length ?? 0,
          expectedController: 'PS5 DualSense / standard mapping',
        });
        findActiveGamepad();

        cleanupListeners.push(() => {
          renderer.domElement.removeEventListener('pointerdown', onPointerDown);
          renderer.domElement.removeEventListener('pointermove', onPointerMove);
          renderer.domElement.removeEventListener('pointerup', onPointerUp);
          renderer.domElement.removeEventListener('pointercancel', onPointerUp);
          renderer.domElement.removeEventListener('wheel', onWheel);
          window.removeEventListener('keydown', onKeyDown);
          window.removeEventListener('keyup', onKeyUp);
          window.removeEventListener('gamepadconnected', onGamepad);
          window.removeEventListener(
            'gamepaddisconnected',
            onGamepadDisconnect,
          );
        });

        const updateSize = () => {
          if (!mountRef.current) return;
          const width = mountRef.current.clientWidth;
          const height = mountRef.current.clientHeight;
          camera.aspect = width / Math.max(height, 1);
          camera.updateProjectionMatrix();
          renderer.setSize(width, height, false);
        };
        resizeObserver = new ResizeObserver(updateSize);
        resizeObserver.observe(mountRef.current);
        updateSize();

        let previous = performance.now();
        let lastRenderedAt = previous;
        let reportAt = previous;
        let streamCheckAt = previous;
        let frameCount = 0;
        let idleFrameMode = false;
        let compassHeading = '';
        const labelAnchor = new THREE.Vector3();
        const navigationScreenPoint = new THREE.Vector3();

        const rotateYawAroundNearPivot = (yawDelta: number) => {
          if (yawDelta === 0) return;
          const farHorizontal = Math.cos(view.pitch) * view.distance;
          const cameraBefore = new THREE.Vector3(
            view.target.x + Math.sin(view.yaw) * farHorizontal,
            view.target.y + Math.sin(view.pitch) * view.distance,
            view.target.z + Math.cos(view.yaw) * farHorizontal,
          );
          const nearHorizontal = Math.cos(view.pitch) * GAMEPAD_PIVOT_DISTANCE;
          const nearPivot = new THREE.Vector3(
            cameraBefore.x - Math.sin(view.yaw) * nearHorizontal,
            cameraBefore.y - Math.sin(view.pitch) * GAMEPAD_PIVOT_DISTANCE,
            cameraBefore.z - Math.cos(view.yaw) * nearHorizontal,
          );
          const nextYaw = view.yaw + yawDelta;
          const cameraAfter = new THREE.Vector3(
            nearPivot.x + Math.sin(nextYaw) * nearHorizontal,
            nearPivot.y + Math.sin(view.pitch) * GAMEPAD_PIVOT_DISTANCE,
            nearPivot.z + Math.cos(nextYaw) * nearHorizontal,
          );
          view.target.set(
            cameraAfter.x - Math.sin(nextYaw) * farHorizontal,
            cameraAfter.y - Math.sin(view.pitch) * view.distance,
            cameraAfter.z - Math.cos(nextYaw) * farHorizontal,
          );
          view.yaw = nextYaw;
        };

        const animate = (now: number) => {
          if (disposed) return;
          const frameGamepad = findActiveGamepad();
          const gamepadHasInput =
            frameGamepad !== null &&
            (frameGamepad.axes.some((value) => refineAxis(value) !== 0) ||
              frameGamepad.buttons.some(
                (button) => button.value > 0.03 || button.pressed,
              ));
          if (gamepadHasInput) noteInteraction();
          const interactive =
            dragging ||
            keys.size > 0 ||
            gamepadHasInput ||
            now - lastInteractionAt < 900;
          const frameInterval = interactive ? 1_000 / 60 : 1_000 / 30;
          if (now - lastRenderedAt < frameInterval) {
            frameHandle = requestAnimationFrame(animate);
            return;
          }
          lastRenderedAt = now;
          if (idleFrameMode === interactive) {
            idleFrameMode = !interactive;
            console.info(
              `[render] ${idleFrameMode ? 'idle power save (30 FPS)' : 'interactive (60 FPS)'}`,
            );
          }
          const delta = Math.min(0.05, (now - previous) / 1000);
          previous = now;
          frameCount += 1;

          const horizontalForward = new THREE.Vector3(
            -Math.sin(view.yaw),
            0,
            -Math.cos(view.yaw),
          );
          const cameraForward = new THREE.Vector3(
            -Math.sin(view.yaw) * Math.cos(view.pitch),
            -Math.sin(view.pitch),
            -Math.cos(view.yaw) * Math.cos(view.pitch),
          );
          const horizontalRight = new THREE.Vector3(
            -horizontalForward.z,
            0,
            horizontalForward.x,
          );
          const cameraUpUnrolled = new THREE.Vector3(
            -Math.sin(view.yaw) * Math.sin(view.pitch),
            Math.cos(view.pitch),
            -Math.cos(view.yaw) * Math.sin(view.pitch),
          );
          const rollCos = Math.cos(view.roll);
          const rollSin = Math.sin(view.roll);
          const cameraRight = horizontalRight
            .clone()
            .multiplyScalar(rollCos)
            .addScaledVector(cameraUpUnrolled, rollSin);
          const cameraUp = cameraUpUnrolled
            .clone()
            .multiplyScalar(rollCos)
            .addScaledVector(horizontalRight, -rollSin);
          const moveSpeed = view.distance * 0.32 * delta;
          if (keys.has('KeyW'))
            view.target.addScaledVector(horizontalForward, moveSpeed);
          if (keys.has('KeyS'))
            view.target.addScaledVector(horizontalForward, -moveSpeed);
          if (keys.has('KeyA'))
            view.target.addScaledVector(horizontalRight, -moveSpeed);
          if (keys.has('KeyD'))
            view.target.addScaledVector(horizontalRight, moveSpeed);
          if (keys.has('KeyQ')) view.target.y -= moveSpeed;
          if (keys.has('KeyE')) view.target.y += moveSpeed;

          const gamepad = frameGamepad;
          if (gamepad) {
            if (
              !warnedAboutMapping &&
              (gamepad.axes.length < 4 || gamepad.buttons.length < 16)
            ) {
              warnedAboutMapping = true;
              console.warn('[gamepad] unexpected controller mapping', {
                index: gamepad.index,
                id: gamepad.id,
                mapping: gamepad.mapping || 'raw',
                axes: gamepad.axes.length,
                buttons: gamepad.buttons.length,
              });
            }

            const buttonValue = (index: number) =>
              gamepad.buttons[index]?.value ??
              (gamepad.buttons[index]?.pressed ? 1 : 0);
            const leftX = refineAxis(gamepad.axes[0] ?? 0);
            const leftY = refineAxis(gamepad.axes[1] ?? 0);
            const rightX = refineAxis(gamepad.axes[2] ?? 0);
            const rightY = refineAxis(gamepad.axes[3] ?? 0);
            const l3Pressed = buttonValue(10) > 0.5;
            const r3Pressed = buttonValue(11) > 0.5;
            // Standard-mapped DualSense controllers expose Square as button 2.
            const squarePressed = buttonValue(2) > 0.5;
            // Standard-mapped DualSense controllers expose Circle as button 1.
            const circlePressed = buttonValue(1) > 0.5;
            const l3JustPressed = l3Pressed && !l3WasPressed;
            const r3JustPressed = r3Pressed && !r3WasPressed;
            const squareJustPressed = squarePressed && !squareWasPressed;
            const circleJustPressed = circlePressed && !circleWasPressed;
            l3WasPressed = l3Pressed;
            r3WasPressed = r3Pressed;
            squareWasPressed = squarePressed;
            circleWasPressed = circlePressed;
            if (squareJustPressed) placeScanRequested = true;
            if (circleJustPressed) {
              annotationsVisible = !annotationsVisible;
              annotationLayer.visible = annotationsVisible;
              console.info('[gamepad] Circle annotations', {
                visible: annotationsVisible,
              });
            }

            const dpadUp = buttonValue(12);
            const dpadDown = buttonValue(13);
            const dpadLeft = buttonValue(14);
            const dpadRight = buttonValue(15);
            const leftBoost = buttonValue(4) > 0.5;
            const rightBoost = buttonValue(5) > 0.5;
            const speedMultiplier =
              (leftBoost ? 16 : 1) * (rightBoost ? 16 : 1);
            const turnMultiplier = (leftBoost ? 2 : 1) * (rightBoost ? 2 : 1);
            const turnSpeed = GAMEPAD_TURN_SPEED_RAD * delta * turnMultiplier;

            const padSpeed = GAMEPAD_MOVE_SPEED_MPS * delta * speedMultiplier;
            view.target.addScaledVector(cameraForward, -leftY * padSpeed);
            rotateYawAroundNearPivot(-leftX * turnSpeed);
            view.target.addScaledVector(cameraRight, rightX * padSpeed);
            view.target.addScaledVector(cameraUp, -rightY * padSpeed);
            // DualSense left D-pad vertical direction is intentionally inverted
            // to match the visual expectation for this camera's pitch axis.
            view.pitch += (dpadDown - dpadUp) * turnSpeed * 0.82;
            view.roll += (dpadRight - dpadLeft) * turnSpeed;

            view.pitch = Math.max(0.08, Math.min(1.28, view.pitch));
            view.roll = Math.atan2(Math.sin(view.roll), Math.cos(view.roll));
            view.distance = Math.max(
              1_100,
              Math.min(
                90_000,
                view.distance *
                  Math.exp((buttonValue(7) - buttonValue(6)) * delta * 1.4),
              ),
            );
            if (r3JustPressed) {
              resetView();
              statsRef.current.gamepadMode = gamepadMode;
              console.info('[gamepad] view reset to Gyirong Port', {
                yaw: view.yaw,
                pitch: view.pitch,
                distance: view.distance,
                target: view.target.toArray(),
              });
            } else if (l3JustPressed) {
              rotateYawAroundNearPivot(-view.yaw);
              view.roll = 0;
              statsRef.current.gamepadMode = gamepadMode;
              console.info('[gamepad] heading reset to north', {
                yaw: view.yaw,
                roll: view.roll,
              });
            }

            const rawAxes = Array.from(gamepad.axes.slice(0, 4));
            const activeButtons = gamepad.buttons.flatMap((button, index) =>
              button.value > 0.03 || button.pressed
                ? [`${index}:${button.value.toFixed(2)}`]
                : [],
            );
            const hasInput =
              rawAxes.some((value) => Math.abs(value) > 0.03) ||
              activeButtons.length > 0;
            statsRef.current.gamepadDebug =
              `#${gamepad.index} ${gamepad.mapping || 'raw'} · ` +
              `M ${speedMultiplier}× / R ${turnMultiplier}× · ` +
              `A ${rawAxes.map((value) => value.toFixed(2)).join(' ')} · ` +
              `B ${activeButtons.join(' ') || '—'}`;

            if (hasInput && now - lastGamepadInputLogAt >= 350) {
              console.info('[gamepad] input', {
                index: gamepad.index,
                mode: gamepadMode,
                speedMultiplier,
                turnMultiplier,
                moveSpeedMps: GAMEPAD_MOVE_SPEED_MPS * speedMultiplier,
                turnSpeedRad: GAMEPAD_TURN_SPEED_RAD * turnMultiplier,
                cameraForward: cameraForward
                  .toArray()
                  .map((value) => Number(value.toFixed(3))),
                cameraRight: cameraRight
                  .toArray()
                  .map((value) => Number(value.toFixed(3))),
                cameraUp: cameraUp
                  .toArray()
                  .map((value) => Number(value.toFixed(3))),
                axes: rawAxes.map((value) => Number(value.toFixed(3))),
                buttons: activeButtons,
                timestamp: gamepad.timestamp,
              });
              lastGamepadInputLogAt = now;
            }
          }

          const horizontalDistance = Math.cos(view.pitch) * view.distance;
          camera.position.set(
            view.target.x + Math.sin(view.yaw) * horizontalDistance,
            view.target.y + Math.sin(view.pitch) * view.distance,
            view.target.z + Math.cos(view.yaw) * horizontalDistance,
          );
          camera.lookAt(view.target);
          camera.rotateZ(view.roll);
          camera.updateMatrixWorld();
          if (placeScanRequested) {
            void loadScannedPlaces();
            let revealed = 0;
            navigationMarkers.forEach((navigationMarker) => {
              navigationMarker.group.getWorldPosition(labelAnchor);
              const distance = camera.position.distanceTo(labelAnchor);
              navigationScreenPoint.copy(labelAnchor).project(camera);
              const visibleInScan =
                distance <= Math.max(navigationMarker.maxDistance, 360_000) &&
                navigationScreenPoint.z >= -1 &&
                navigationScreenPoint.z <= 1 &&
                Math.abs(navigationScreenPoint.x) <= 0.96 &&
                Math.abs(navigationScreenPoint.y) <= 0.9;
              navigationMarker.temporarilyRevealed = visibleInScan;
              if (visibleInScan) revealed += 1;
            });
            placeScanRequested = false;
            console.info('[gamepad] Square place scan', {
              revealed,
              camera: camera.position
                .toArray()
                .map((value) => Number(value.toFixed(0))),
            });
          }
          if (northNeedleRef.current) {
            northNeedleRef.current.style.transform = `rotate(${view.yaw}rad)`;
          }
          const compassHeadingIndex =
            ((Math.round(-view.yaw / (Math.PI / 2)) % 4) + 4) % 4;
          const nextCompassHeading = ['north', 'east', 'south', 'west'][
            compassHeadingIndex
          ];
          if (nextCompassHeading !== compassHeading) {
            compassHeading = nextCompassHeading;
            northDialRef.current?.setAttribute(
              'data-heading',
              nextCompassHeading,
            );
            const headingText = ['北 N', '东 E', '南 S', '西 W'][
              compassHeadingIndex
            ];
            if (northHeadingRef.current) {
              northHeadingRef.current.textContent = `画面上方 · ${headingText}`;
            }
          }
          marker.rotation.y = -view.yaw;
          annotationLabels.forEach((label) => {
            const data = label.userData.annotationLabel as AnnotationLabelData;
            if (data.baseOffset && label.parent) {
              label.parent.getWorldPosition(labelAnchor);
            } else {
              label.getWorldPosition(labelAnchor);
            }
            const labelDistance = camera.position.distanceTo(labelAnchor);
            const scaleFactor = Math.min(
              data.maxScale ?? 1,
              Math.max(labelDistance, 40) /
                (data.screenScaleDistance ?? 38_000),
            );
            label.scale.set(
              data.baseScale[0] * scaleFactor,
              data.baseScale[1] * scaleFactor,
              1,
            );
            if (data.baseOffset) {
              label.position.set(
                data.baseOffset[0] * scaleFactor,
                data.baseOffset[1] * scaleFactor,
                data.baseOffset[2] * scaleFactor,
              );
            }
          });
          navigationMarkers.forEach((navigationMarker) => {
            const { group, maxDistance } = navigationMarker;
            group.getWorldPosition(labelAnchor);
            const distance = camera.position.distanceTo(labelAnchor);
            navigationScreenPoint.copy(labelAnchor).project(camera);
            const centeredNavigation =
              distance <= maxDistance &&
              navigationScreenPoint.z >= -1 &&
              navigationScreenPoint.z <= 1 &&
              Math.abs(navigationScreenPoint.x) <= 0.72 &&
              Math.abs(navigationScreenPoint.y) <= 0.68;
            const remainsInScanRange =
              distance <= Math.max(maxDistance, 360_000) &&
              navigationScreenPoint.z >= -1 &&
              navigationScreenPoint.z <= 1 &&
              Math.abs(navigationScreenPoint.x) <= 0.98 &&
              Math.abs(navigationScreenPoint.y) <= 0.94;
            if (!remainsInScanRange) {
              navigationMarker.temporarilyRevealed = false;
            }
            group.visible =
              centeredNavigation || navigationMarker.temporarilyRevealed;
          });
          sky.position.set(
            camera.position.x,
            camera.position.y,
            camera.position.z,
          );
          cloudLayer.position.set(
            camera.position.x,
            camera.position.y,
            camera.position.z,
          );
          distantCloudLayer.position.copy(cloudLayer.position);
          cloudLayer.rotation.y = now * 0.0000025;
          distantCloudLayer.rotation.y = 1.1 - now * 0.0000014;

          if (now - streamCheckAt >= 350) {
            const focusX = Math.floor(
              centerTile.x + view.target.x / tileMeterSize,
            );
            const focusY = Math.floor(
              centerTile.y + view.target.z / tileMeterSize,
            );
            const nextLodSignature = getLodSignature(
              getStreamCoordinates(
                focusX,
                focusY,
                camera.position,
                terrainTileRecords,
              ),
            );
            if (
              focusX !== residentFocusX ||
              focusY !== residentFocusY ||
              nextLodSignature !== residentLodSignature
            ) {
              requestTerrainWindow(focusX, focusY, camera.position);
            }
            const horizonFocusX = Math.floor(focusX / horizonTileScale);
            const horizonFocusY = Math.floor(focusY / horizonTileScale);
            const wantsFarHorizon =
              camera.position.y >= FAR_HORIZON_ACTIVATION_HEIGHT;
            if (
              horizonFocusX !== horizonResidentX ||
              horizonFocusY !== horizonResidentY ||
              wantsFarHorizon !== horizonResidentFar
            ) {
              requestHorizonWindow(focusX, focusY, wantsFarHorizon);
            }
            streamCheckAt = now;
          }

          renderer.render(scene, camera);

          if (now - reportAt >= 700) {
            statsRef.current.fps = Math.round(
              (frameCount * 1_000) / (now - reportAt),
            );
            statsRef.current.renderer = 'WEBGPU';
            onStats({ ...statsRef.current });
            reportAt = now;
            frameCount = 0;
          }

          frameHandle = requestAnimationFrame(animate);
        };

        statsRef.current.renderer = 'WEBGPU';
        onStats({ ...statsRef.current });
        setLoading('');
        frameHandle = requestAnimationFrame(animate);
        const distantTerrainHandle = window.setTimeout(() => {
          requestTerrainWindow(tileX, tileY, camera.position);
        }, 650);
        cleanupListeners.push(() => window.clearTimeout(distantTerrainHandle));

        cleanupListeners.push(() => {
          scene.traverse((object) => {
            if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
              object.geometry.dispose();
            }
          });
          materialRefs.current.forEach(({ material, texture }) => {
            material.dispose();
            texture?.dispose();
          });
          renderer.dispose();
          renderer.domElement.remove();
        });
      } catch (error) {
        console.error(error);
        statsRef.current.renderer = 'UNAVAILABLE';
        onStats({ ...statsRef.current });
        setIssue(
          error instanceof Error
            ? error.message
            : '地形初始化失败，请刷新后重试。',
        );
      }
    }

    void initialize();

    return () => {
      disposed = true;
      cancelAnimationFrame(frameHandle);
      resizeObserver?.disconnect();
      cleanupListeners.forEach((cleanup) => cleanup());
      terrainRef.current = null;
      materialRefs.current = [];
      resetRef.current = null;
    };
  }, [center.latitude, center.longitude, highDetail, mapSource, onStats]);

  return (
    <div ref={mountRef} className="terrain-viewport">
      <figure className="north-indicator" aria-label="方向罗盘">
        <span ref={northDialRef} className="north-dial" aria-hidden="true">
          <span className="compass-cardinal compass-north">北</span>
          <span className="compass-cardinal compass-east">东</span>
          <span className="compass-cardinal compass-south">南</span>
          <span className="compass-cardinal compass-west">西</span>
          <span ref={northNeedleRef} className="north-needle">
            <svg viewBox="0 0 40 40">
              <path className="north-arrow" d="M20 3 29 30 20 25 11 30Z" />
              <path className="south-arrow" d="m11 30 9-5 9 5-9 7Z" />
              <circle cx="20" cy="25" r="2.2" />
            </svg>
          </span>
        </span>
        <b ref={northHeadingRef}>画面上方 · 北 N</b>
        <span className="north-ai-note">AI 协助生成演示</span>
      </figure>
      {loading && !issue ? (
        <output className="loading-screen">
          <div className="loading-radar">
            <span />
          </div>
          <p>{loading}</p>
          <span>解析吉隆口岸高程瓦片</span>
        </output>
      ) : null}
      {issue ? (
        <div className="unsupported-screen" role="alert">
          <MountainIcon />
          <p>WEBGPU UNAVAILABLE</p>
          <h2>无法启动地形引擎</h2>
          <span>{issue}</span>
        </div>
      ) : null}
    </div>
  );
}

function MountainIcon() {
  return (
    <svg viewBox="0 0 64 48" aria-hidden="true">
      <path
        d="M3 43 22 12l9 15L40 9l21 34H3Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="m16 22 6-10 6 10m4 6 8-19 8 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}
