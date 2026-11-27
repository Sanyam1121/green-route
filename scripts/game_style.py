"""Builds styles/game.json: a dark, neutral-grey map in the spirit of a game's pause map and radar.
Run: python3 scripts/game_style.py"""
import json, pathlib

P = dict(  # palette
    land='#2f3336', res='#34383b', building='#3f4448', building_line='#484e52',
    park='#2f4733', wood='#2a4230', grass='#33493a', sand='#4f4b3c', aero='#3a3e41',
    water='#2e5068', waterway='#3f6c88',
    casing='#191c1e', path='#5d6266', service='#575c60', minor='#7a7f83', tertiary='#979b9e',
    secondary='#adb0b2', primary='#c4c6c7', trunk='#d9dadb', motorway='#ececec', rail='#55595c',
    label='#d3d6d8', label_dim='#a7abae', halo='#121416', water_label='#8fb6cf',
)

def w(*stops):
    return ['interpolate', ['exponential', 1.5], ['zoom'], *stops]

def cls(*names):
    return ['match', ['get', 'class'], list(names), True, False]

NOT_TUNNEL = ['match', ['get', 'brunnel'], ['tunnel'], False, True]
name = ['coalesce', ['get', 'name:en'], ['get', 'name']]

layers = [
    {'id': 'land', 'type': 'background', 'paint': {'background-color': P['land']}},
    {'id': 'landuse-res', 'type': 'fill', 'source': 'om', 'source-layer': 'landuse',
     'filter': cls('residential', 'suburb', 'neighbourhood', 'commercial', 'retail', 'industrial'),
     'paint': {'fill-color': P['res'], 'fill-opacity': 0.9}},
    {'id': 'park', 'type': 'fill', 'source': 'om', 'source-layer': 'park', 'paint': {'fill-color': P['park']}},
    {'id': 'landcover', 'type': 'fill', 'source': 'om', 'source-layer': 'landcover',
     'filter': cls('wood', 'grass', 'farmland', 'wetland'),
     'paint': {'fill-color': ['match', ['get', 'class'], 'wood', P['wood'], P['grass']], 'fill-opacity': 0.8}},
    {'id': 'landcover-sand', 'type': 'fill', 'source': 'om', 'source-layer': 'landcover', 'filter': cls('sand'),
     'paint': {'fill-color': P['sand']}},
    {'id': 'landuse-green', 'type': 'fill', 'source': 'om', 'source-layer': 'landuse',
     'filter': cls('pitch', 'stadium', 'cemetery', 'grass', 'park', 'playground'),
     'paint': {'fill-color': P['park'], 'fill-opacity': 0.85}},
    {'id': 'water', 'type': 'fill', 'source': 'om', 'source-layer': 'water',
     'filter': ['!=', ['get', 'brunnel'], 'tunnel'], 'paint': {'fill-color': P['water']}},
    {'id': 'waterway', 'type': 'line', 'source': 'om', 'source-layer': 'waterway',
     'filter': ['!=', ['get', 'brunnel'], 'tunnel'],
     'paint': {'line-color': P['waterway'], 'line-width': w(10, 0.6, 16, 3)}},
    {'id': 'aeroway', 'type': 'fill', 'source': 'om', 'source-layer': 'aeroway',
     'filter': ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], True, False],
     'paint': {'fill-color': P['aero']}},
    {'id': 'building', 'type': 'fill', 'source': 'om', 'source-layer': 'building', 'minzoom': 14,
     'paint': {'fill-color': P['building'], 'fill-outline-color': P['building_line'],
               'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 15.5, 1]}},
]

ROADS = [  # class, colour, casing width stops, line width stops
    ('minor', P['minor'], (12, 0.8, 14, 2.6, 18, 11), (12, 0.5, 14, 1.6, 18, 9)),
    ('tertiary', P['tertiary'], (10, 1, 14, 3.6, 18, 14), (10, 0.6, 14, 2.4, 18, 12)),
    ('secondary', P['secondary'], (9, 1.2, 14, 4.4, 18, 16.5), (9, 0.7, 14, 3, 18, 14)),
    ('primary', P['primary'], (8, 1.4, 14, 5.2, 18, 19), (8, 0.8, 14, 3.6, 18, 16)),
    ('trunk', P['trunk'], (6, 1.4, 14, 6, 18, 21), (6, 0.8, 14, 4.2, 18, 18)),
    ('motorway', P['motorway'], (5, 1.4, 14, 6.6, 18, 23), (5, 0.8, 14, 4.6, 18, 20)),
]
MINZ = {'minor': 12, 'tertiary': 10, 'secondary': 9, 'primary': 8, 'trunk': 6, 'motorway': 5}
for c, _, cw, _ in ROADS:
    layers.append({'id': f'road-{c}-casing', 'type': 'line', 'source': 'om', 'source-layer': 'transportation',
                   'minzoom': MINZ[c], 'filter': ['all', cls(c), NOT_TUNNEL],
                   'layout': {'line-cap': 'round', 'line-join': 'round'},
                   'paint': {'line-color': P['casing'], 'line-width': w(*cw)}})
layers += [
    {'id': 'road-path', 'type': 'line', 'source': 'om', 'source-layer': 'transportation', 'minzoom': 14,
     'filter': ['all', cls('path'), NOT_TUNNEL],
     'paint': {'line-color': P['path'], 'line-width': w(14, 0.5, 18, 2), 'line-dasharray': [1.5, 1.5]}},
    {'id': 'road-service', 'type': 'line', 'source': 'om', 'source-layer': 'transportation', 'minzoom': 13,
     'filter': ['all', cls('service', 'track'), NOT_TUNNEL], 'layout': {'line-cap': 'round', 'line-join': 'round'},
     'paint': {'line-color': P['service'], 'line-width': w(13, 0.4, 18, 5)}},
]
for c, col, _, lw in ROADS:
    layers.append({'id': f'road-{c}', 'type': 'line', 'source': 'om', 'source-layer': 'transportation',
                   'minzoom': MINZ[c], 'filter': ['all', cls(c), NOT_TUNNEL],
                   'layout': {'line-cap': 'round', 'line-join': 'round'},
                   'paint': {'line-color': col, 'line-width': w(*lw)}})
layers += [
    {'id': 'rail', 'type': 'line', 'source': 'om', 'source-layer': 'transportation', 'minzoom': 10,
     'filter': cls('rail', 'transit'),
     'paint': {'line-color': P['rail'], 'line-width': w(10, 0.8, 16, 2.4), 'line-dasharray': [3, 2]}},
    {'id': 'road-label', 'type': 'symbol', 'source': 'om', 'source-layer': 'transportation_name', 'minzoom': 15,
     'filter': cls('primary', 'secondary', 'tertiary', 'trunk', 'minor', 'motorway'),
     'layout': {'symbol-placement': 'line', 'text-field': ['upcase', name], 'text-font': ['Noto Sans Bold'],
                'text-size': w(15, 9, 18, 12), 'text-letter-spacing': 0.1, 'text-pitch-alignment': 'viewport'},
     'paint': {'text-color': P['label_dim'], 'text-halo-color': P['halo'], 'text-halo-width': 1.4}},
    {'id': 'water-label', 'type': 'symbol', 'source': 'om', 'source-layer': 'water_name',
     'layout': {'text-field': ['upcase', name], 'text-font': ['Noto Sans Italic'], 'text-size': 11,
                'text-letter-spacing': 0.15},
     'paint': {'text-color': P['water_label'], 'text-halo-color': P['halo'], 'text-halo-width': 1.2}},
    {'id': 'place-small', 'type': 'symbol', 'source': 'om', 'source-layer': 'place', 'minzoom': 12,
     'filter': cls('suburb', 'neighbourhood', 'quarter', 'hamlet', 'village', 'locality'),
     'layout': {'text-field': ['upcase', name], 'text-font': ['Noto Sans Bold'], 'text-size': w(12, 10, 16, 13),
                'text-letter-spacing': 0.18, 'text-max-width': 8},
     'paint': {'text-color': P['label'], 'text-halo-color': P['halo'], 'text-halo-width': 1.6}},
    {'id': 'place-town', 'type': 'symbol', 'source': 'om', 'source-layer': 'place', 'filter': cls('town', 'city'),
     'layout': {'text-field': ['upcase', name], 'text-font': ['Noto Sans Bold'], 'text-size': w(6, 11, 12, 18, 15, 22),
                'text-letter-spacing': 0.25},
     'paint': {'text-color': '#ffffff', 'text-halo-color': P['halo'], 'text-halo-width': 2}},
]

style = {'version': 8, 'name': 'Green Route – Game',
         'sources': {'om': {'type': 'vector', 'url': 'https://tiles.openfreemap.org/planet',
                            'attribution': '© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors'}},
         'glyphs': 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf', 'layers': layers}
out = pathlib.Path(__file__).resolve().parent.parent / 'styles' / 'game.json'
out.write_text(json.dumps(style, separators=(',', ':')))
print(out, len(layers), 'layers')
