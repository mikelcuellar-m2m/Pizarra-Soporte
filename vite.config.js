import { defineConfig } from 'vite'

// En desarrollo (npm run dev en :5173) redirige las conexiones de Socket.IO
// al servidor Node (npm run start en :3000), para poder probar la colaboración.
export default defineConfig({
  server: {
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
