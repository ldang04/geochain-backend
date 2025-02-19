const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const stringSimilarity = require("string-similarity");
const path = require('path');

const app = express();
const server = http.createServer(app);

// Allow CORS for Express routes (optional, for REST APIs)
app.use(cors());
app.use(express.json()); // For parsing application/json
app.use(express.urlencoded({ extended: true })); // For parsing application/x-www-form-urlencoded

const buildPath = path.join(__dirname, '..', 'client', 'build');
app.use(express.static(buildPath));

// Serve static files from the React app
// app.use(express.static(path.join(__dirname, 'client', 'public')));

// API routes ==============================================================================================================
app.get("/api", (req, res) => {
    res.send("Hello, world!"); 
});

app.get('/api/create_game', (req, res) => {
    const gameId = uuidv4(); // Generate a unique ID for the game
    console.log("SERVER HIT");
    res.json({ gameId }); // Send the game ID back to the client
});

app.get('/api/check-room/:roomId', (req, res) => {
    const { roomId } = req.params;
    const roomExists = Boolean(gameRooms[roomId]); // Check if the room exists in the gameRooms object
    res.json({ exists: roomExists });
});

app.post("/api/validate_location", (req, res) => {
    const { gameId, location } = req.body;
    if (!gameId || !location) {
        return res.status(400).json({ success: false, message: "Missing gameId or location." });
    }

    // Validate the location (example validation logic)
    const validationResponse = validateLocation(location, gameId);

    console.log(validationResponse);
    res.json(validationResponse);
});

// Serve React frontend for all other routes
app.get('/*', (req, res) => {
    res.sendFile(path.join(buildPath, 'index.html'), (err) => {
        if (err) {
            res.status(500).send(err);
        }
    });
});
  
  // resolve potential favicon errors
  app.get('/favicon.ico', (req, res) => {
    res.sendFile(path.join(buildPath, 'favicon.ico'));
});

// WEB SOCKET CONFIG ===========================================================================================================================

// Initialize Socket.IO with CORS settings
const io = new Server(server, {
    cors: {
        origin: ["http://localhost:3000", "https://geochain-io-fce6055b2802.herokuapp.com/"], 
        methods: ["GET", "POST"],
        credentials: true
    },
});

const gameRooms = {}; // Store users and game data for each room

io.on("connection", (socket) => {
    console.log("A user connected:", socket.id);

    // Handle user joining a room
    socket.on("join-room", ({ gameId, nickname, timeLimit, lives }) => {
        if (!gameRooms[gameId]) {
            gameRooms[gameId] = {
                isStarted: false,
                users: [],
                locations: [],
                currentLetter: "A",
                currentTurnIndex: 0,
                timeLimit: timeLimit ?? 60, // Default to 60 seconds
                timeLeft: timeLimit ?? 60, // Set to the timeLimit
                timer: null, // Timer for the current turn
                lives: lives ?? 3, // Default to 3 lives
                guessedLocations: new Set(),
                isSolo: false, // Default to multiplayer
            };
        }
    
        const room = gameRooms[gameId];
    
        // Prevent users from joining if the game has already started
        if (room.isStarted) {
            socket.emit("game-started-error", { message: "The game has already started." });
            return;
        }
    
        // Add the user to the room
        const user = { id: socket.id, name: nickname, lives: room.lives };
        room.users.push(user);
        socket.join(gameId);
    
        // Send the previous locations and markers to the newly joined user
        socket.emit("initialize-game", {
            locations: room.locations,
            markers: room.locations.map((loc) => {
                const locationData = Array.from(locationsMap.values()).find(
                    (item) => item.name_standard === loc
                );
                return locationData
                    ? {
                          latitude: locationData.latitude,
                          longitude: locationData.longitude,
                          name: locationData.name_standard,
                      }
                    : null;
            }).filter(Boolean),
            currentLetter: room.currentLetter,
            users: room.users,
            currentTurn: room.users[room.currentTurnIndex],
            timeLimit: room.timeLimit, // Send the room's time limit
            timeLeft: room.timeLeft,
            timer: room.timer,
        });
    
        io.to(gameId).emit("update-users", room.users);
        // IMPORTANT: Update-turn emission updates both the current user, and their timeLeft. 
        io.to(gameId).emit("update-turn", room.users[room.currentTurnIndex]);
        io.to(gameId).emit("update-timeLeft", room.timeLeft);
        console.log(`User ${nickname} joined room ${gameId}`);
    });
    
    
    
    // start a game 
    socket.on("start-game-pressed", ({ gameId }) => {
        const room = gameRooms[gameId];
    
        // Check if the room exists
        if (!room) {
            socket.emit("start-game-pressed-error", { message: "The specified room does not exist." });
            return;
        }
    
        // Check if the game is already started
        if (room.isStarted) {
            socket.emit("game-started-error", { message: "Game has already started." });
            return;
        }
    
        // Mark the game as started
        room.isStarted = true;

        // Logic to set whether the game is solo or multiplayer
        if (room.users.length === 1) {
            room.isSolo = true;
            console.log('Solo game enabled');
        }  else {
            room.isSolo = false; // Default back to multiplayer
            console.log('Multiplayer game enabled');
        }
    
        // Notify all players that the game has started
        io.to(gameId).emit("game-started", {
            currentLetter: room.currentLetter,
            currentTurn: room.users[room.currentTurnIndex],
            timeLimit: room.timeLimit,
            timeLeft: room.timeLeft,
            timer: room.timer,
            users: room.users.map((user) => ({
                id: user.id,
                name: user.name,
                lives: user.lives, // Include remaining lives if lives are being tracked
            })),
            locations: room.locations, // Send any pre-existing guessed locations
            isSolo: room.isSolo, // Send whether the game is solo or multiplayer
        });

        // Start the timer for the round: 
        startTurnTimer(gameId);
    
        console.log(`Game started in room ${gameId}`);
    });

    const checkEnd = (gameId) => {
        const room = gameRooms[gameId];
        if (!room) return;

        // Check if only one player is left in a multiplayer game
        const remainingPlayers = room.users.filter(user => user.lives > 0);
        if (remainingPlayers.length === 1 && !room.isSolo) {
            const winner = remainingPlayers[0];
            console.log(`Multi game end`);
            io.to(gameId).emit("end-game", { 
                reason: "Last player standing", 
                winner: winner.name, 
                totalLocations: room.locations.length,
                isSolo: room.isSolo 
            });
            return;
        } else if (room.isSolo && room.users[0].lives <= 0) {
            // Solo game ends when the player loses all lives
            let timestamp = new Date().toISOString();
            console.log(`[${timestamp}] ENDING GAME`);
            console.log("Checking solo end condition:", room.isSolo, room.users[0].lives);
            console.log(`Emitting to room ${gameId} with users:`, room.users);

            io.to(gameId).emit("end-game", { 
                reason: "You lost all lives", 
                winner: "SOLO", // No winner in solo game
                totalLocations: room.locations.length,
                isSolo: room.isSolo 
            });
            return;
        } 
        else if (!room.isSolo && room.users.length === 1) {
            const winner = room.users[0]; // The remaining player is the winner
            console.log(`Multi game default win`);
            io.to(gameId).emit("end-game", { 
                reason: "Players have disconnected in multiplayer game", 
                winner: winner.name, 
                totalLocations: room.locations.length,
                isSolo: room.isSolo 
            });
            return;
        }
    }

    const startTurnTimer = (gameId) => {
        const room = gameRooms[gameId];
        if (!room) return;
    
        if (room.timer) {
            clearInterval(room.timer);
            room.timer = null;
        }
    
        room.timeLeft = room.timeLimit;
    
        room.timer = setInterval(() => {
            // Update timeLeft
            io.to(gameId).emit("update-timeLeft", room.timeLeft);
            room.timeLeft -= 1;
    
            if (room.timeLeft <= 0) {
                clearInterval(room.timer);
    
                const currentTurnUser = room.users[room.currentTurnIndex];
                if (currentTurnUser.lives > 0) {
                    currentTurnUser.lives -= 1;
                    io.to(gameId).emit("update-users", room.users);
                }
                
                // EXPLICIT END GAME CHECK in place of checkEnd():
                // Might have introduced race conditions that could've caused other emissions to fire before end-game.
                // Specifically, this would prevent the end-game sequence during a solo game. 
                const remainingPlayers = room.users.filter(user => user.lives > 0);
                if (remainingPlayers.length === 1 && !room.isSolo) {
                    const winner = remainingPlayers[0];
                    console.log(`Multi game end`);
                    io.to(gameId).emit("end-game", { 
                        reason: "Last player standing", 
                        winner: winner.name, 
                        totalLocations: room.locations.length,
                        isSolo: room.isSolo 
                    });
                    return;
                } else if (room.isSolo && room.users[0].lives <= 0) {
                    // Solo game ends when the player loses all lives
                    let timestamp = new Date().toISOString();
                    console.log(`[${timestamp}] ENDING GAME`);
                    console.log("Checking solo end condition:", room.isSolo, room.users[0].lives);
                    console.log(`Emitting to room ${gameId} with users:`, room.users);

                    io.to(gameId).emit("end-game", { 
                        reason: "You lost all lives", 
                        winner: "SOLO", // No winner in solo game
                        totalLocations: room.locations.length,
                        isSolo: room.isSolo 
                    });
                    return;
                } 
                else if (!room.isSolo && room.users.length === 1) {
                    const winner = room.users[0]; // The remaining player is the winner
                    console.log(`Multi game default win`);
                    io.to(gameId).emit("end-game", { 
                        reason: "Players have disconnected in multiplayer game", 
                        winner: winner.name, 
                        totalLocations: room.locations.length,
                        isSolo: room.isSolo 
                    });
                    return;
                }
    
                passTurn(gameId);
            }
            // Update at start and end of function. 
            io.to(gameId).emit("update-timeLeft", room.timeLeft);
        }, 1000);
    };    

    const passTurn = (gameId) => {
        const room = gameRooms[gameId];
        if (!room) return;
    
        // Move to the next turn
        let nextTurnUser;
        do {
            room.currentTurnIndex = (room.currentTurnIndex + 1) % room.users.length;
            nextTurnUser = room.users[room.currentTurnIndex];
        } while (nextTurnUser.lives <= 0); // Skip users with no lives
    
        room.timeLeft = room.timeLimit; // Reset the time for the next turn
    
        // Notify all clients
        io.to(gameId).emit("update-turn", nextTurnUser);
        io.to(gameId).emit("update-timeLeft", room.timeLeft);
    
        startTurnTimer(gameId);
    };        

    // Handle adding a location
    socket.on("add-location", ({ gameId, location }) => {
        if (!gameRooms[gameId]) return;
    
        // Validate the location within the context of the room
        const validationResponse = validateLocation(location, gameId);
    
        if (validationResponse.success) {
            const room = gameRooms[gameId];
            const locationData = validationResponse.location_data;
    
            // Add the location to the room's location list
            room.locations.push(locationData.name_standard);
    
            // Calculate the new current letter
            const lastLetter = locationData.name_standard.slice(-1).toUpperCase();
    
            // Update the current letter for the room
            room.currentLetter = lastLetter;
            io.to(gameId).emit("update-current-letter", lastLetter); // Emit only on success
    
            io.to(gameId).emit("update-locations", room.locations);
            
            // Pass the turn
            passTurn(gameId);

            // Reset timer
            startTurnTimer(gameId);
    
            // Emit the new marker to all clients in the room
            io.to(gameId).emit("add-marker", {
                latitude: locationData.latitude,
                longitude: locationData.longitude,
                name: locationData.name_standard,
            });
    
            console.log(`Location added in room ${gameId}: ${location}`);
        } else {
            // Send error back to the user
            socket.emit("location-error", validationResponse.message);
            console.log(validationResponse.message);
        }
    });    
    
    // Handle changing the current letter
    socket.on("change-current", ({ gameId, letter }) => {
        if (!gameRooms[gameId]) return;

        // Update the current letter for the room
        gameRooms[gameId].currentLetter = letter;

        // Broadcast the updated current letter
        io.to(gameId).emit("update-current-letter", letter);

        console.log(`Current letter updated in room ${gameId}: ${letter}`);
    });

    // Listen for the update-life event (when a user loses a life)
    socket.on("update-life", ({ gameId, userId, newLives }) => {
        const room = gameRooms[gameId];
        if (!room) return;

        // Find the user (current) and update their lives
        const user = room.users.find(user => user.id === userId);
        if (user) {
            user.lives = newLives;

            // Emit the updated users list to all clients in the room
            io.to(gameId).emit("update-users", room.users);
        }
        checkEnd(gameId);
    });

    // Handle user disconnecting
    socket.on("disconnect", () => {
        console.log(`User ${socket.id} disconnected`);

        // Remove the user from the room they were in
        for (const gameId in gameRooms) {
            const room = gameRooms[gameId];
            const userIndex = room.users.findIndex((user) => user.id === socket.id);

            if (userIndex !== -1) {
                room.users.splice(userIndex, 1);

                // Adjust the current turn index if necessary
                if (room.currentTurnIndex >= userIndex) {
                    room.currentTurnIndex = (room.currentTurnIndex - 1 + room.users.length) % room.users.length;
                }

                // Broadcast the updated user list and turn
                io.to(gameId).emit("update-users", room.users);
                if (room.users.length > 0) {
                    const nextTurnUser = room.users[room.currentTurnIndex];
                    io.to(gameId).emit("update-turn", nextTurnUser);
                    room.timeLeft = room.timeLimit;
                    io.to(gameId).emit("update-timeLeft", room.timeLeft);
                } else {
                    clearInterval(room.timer); 
                }
                
                // At a disconnect, we need to check for the last end condition: Mulitplayer game and all but one user disconnects 
                // Can't check for solo game here, as if solo game ends, disconnect will fire and the socket disconnects. 
                // This causes the game room to be empty, throwing a null pointer exception checking for end conditions. 
                if (!room.isSolo) {
                    checkEnd(gameId);
                }
            }
        } 
    });

});

// Location hashmap. ==============================================================================================================
// libraries to create the hashmap. 
const fs = require('fs');
const csv = require('csv-parser');

class LocationData {
    constructor(latitude, longitude, name_standard) {
        this.isGuessed = false; // Initially, no location is guessed
        this.latitude = latitude;
        this.longitude = longitude;
        this.name_standard = name_standard;
    }
}

// HashMap for locations
const locationsMap = new Map();

// Load CSV data into the locationsMap
function loadLocations(csvFilePath) {
    return new Promise((resolve, reject) => {
        // Connect incoming CSV into the csv-parser, csv(). 
        fs.createReadStream(csvFilePath)
            .pipe(csv())
            .on('data', (row) => {
                // Normalize the name used for the hashmap key. 
                const name = row.name.toLowerCase().trim();
                // New entry into the locationsMap
                // Note: in this case, name_standard is the unmodified location name. 
                locationsMap.set(name, new LocationData(row.latitude, row.longitude, row.name));
            })
            .on('end', () => {
                console.log('CSV loaded successfully.');
                resolve();
            })
            .on('error', (err) => {
                console.error('Error reading CSV:', err);
                reject(err);
            });
    });
}

function validateLocation(input, gameId) { 
    // Normalize input to format of locationsMap key
    const inputName = input.toLowerCase().trim();

    // Find the closest match in the hashmap
    const keys = Array.from(locationsMap.keys());
    const { bestMatch } = stringSimilarity.findBestMatch(inputName, keys);

    if (bestMatch.rating > 0.95) { // Threshold for similarity set at 0.95
        const location = locationsMap.get(bestMatch.target);

        // Check if the location has already been guessed in this room
        const guessedLocations = gameRooms[gameId]?.guessedLocations;
        if (guessedLocations?.has(bestMatch.target)) {
            return { success: false, message: `"${bestMatch.target}" has already been guessed!` };
        } else {
            // Mark the location as guessed for this specific room
            guessedLocations?.add(bestMatch.target);
            return { success: true, location_data: location };
        }
    } else {
        return { success: false, message: `"${input}" is not a valid location!` };
    }
}


// const locationsCSVFilePath = "../client/build/assets/datasets/cleaned_CCS_dataset.csv";
const locationsCSVFilePath = path.join(__dirname, 'datasets', 'cleaned_CCS_dataset.csv');

loadLocations(locationsCSVFilePath).then(() => {
    // console.log('Locations loaded into hashmap:', locationsMap);
});

// Start the server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
