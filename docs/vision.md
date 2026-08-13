# Game Design Thoughts

Possible Title: "Casas Eternas: Herederos del Mundo"

> Don't touch The Vision (tm), this is a human document.

## Game Mechanic Ideas

* The game will be a civ-style empire building game.
* It will probably also support some sort of trade simulation.
* As a starting point it will simulate small tribes / villages.
* Like simulating farming and very basic trading.
* Trading leads to some small villages become towns.
* Few towns become cities, all based on a trade network.
* The initial placement of the villages should make sense.
* But for all of this first thing to do is to generate a world.
* Should be multiplayer capable.
* Explicitly shy away from traditional game logic and have a microservie architecture in mind.
* Even if it can lead to inconsistencies, we should have that in mind for the actual game logic.
* Use SSO for authentication.
* Could end up in some sort of dynasty simulation like Crusader Kings.

## Technical Ideas

* Use a cube-sphere as the planet, great for LoD.
* Only overlay hex tiles on a local level.
* Each village could have its own regional hex map overlayd.
* Hex map should still be deterministic, based on its location on the sphere.
* We dont need to worry about bounries between different hex maps.
* Villages / settlements should have a reasonable min distance between each other.
* For long distance routing / pathfinding roads are used, which are sepearate geometric structures.
* Roads are created between settlements, they dont need to perfectly align with the hex maps.
* Only near settlements they should fit into the local hex grid.
* Locally `honeycomb.js` can be used for pathfinding.
* Use `babylon.js` for game rendering.

> Lets think about why i want to use hexagons so badly 🤔
> I mean they are the bestagons, but what do i exactly get from it?

## World Generation

### Phase 1: Generate Continents

* Generate rough continents
* Use vonoroi cells, group a couple together as continents.
* Maybe distinct between continental and oceanic plates.

### Phase 2: Plate Tectonics

* Plate tectonics, using vonoroi cells.
* Plate tectonics should be somewhat realistic, can be computationally intensive.
* Should form beleivable mountain ranges.

### Phase 3: Errosion Effects

* Errosion, should be used to refine the landmass.
* Especially to make the mountains more beleivable.
* Using ridged fractal noise to make realistic ridges and valleys.

### Phase 4: Generate Rivers and Lakes

* Generate rivers and lakes.
* Using standard D8 flow-direction and flow-accumulation
* Lakes should be not too big.
* A lake should have at least an outlet.

### Phase 5: Simulate Climate and Generate Biomes

* Humidity calculation and biome generation
* Create a temperature grade from equator to poles.
* Create wind bands from equator to poles, with alternate direction.
* Temperature defines the max amount of moisture the air can store.
* With temperature and wind in mind, air picks up water over ocean tiles and drops moisture on land tiles.
* Should take terrain elevation to decide how much moisture is released.
* Higher elevation cools air, making it drop more water.
* Mountain ranges should create rain shadows.
