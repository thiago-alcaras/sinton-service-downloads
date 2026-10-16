# Sinton Desktop

Aplicativo do Sinton para Windows e macOS. Ele abre a interface padrão do Sinton Web e inicia o Serviço Sinton em segundo plano, usando o computador para consultar as fontes e reproduzir vídeos. O modo TV não fica disponível neste aplicativo.

## Baixar

Os instaladores oficiais ficam na página [Releases](https://github.com/thiago-alcaras/sinton-service-downloads/releases). No Windows, baixe `Sinton-Setup-...exe`. No macOS, use o arquivo `.dmg` que corresponde ao processador Intel ou Apple Silicon.

Os aplicativos ainda são distribuídos sem assinatura de desenvolvedor. O Windows pode mostrar uma tela do SmartScreen. No macOS, abra o app pelo menu de contexto se o Gatekeeper bloquear a primeira execução.

## Desenvolvimento

Requer Node.js 24 ou superior e Python com Pillow para gerar os ícones.

```sh
npm ci
npm ci --prefix service-runtime
git clone https://github.com/thiago-alcaras/sinton-tv.git ../sinton-tv
npm run build:win
```

Em macOS, `npm run build:mac` produz um pacote para a arquitetura do Mac atual. As releases oficiais incluem builds Intel e Apple Silicon. A compilação usa o serviço atual de `sinton-tv`, mas não modifica nem publica o site.

## Publicar uma versão

Crie e envie uma tag `vX.Y.Z`. O GitHub Actions prepara o instalador Windows e os dois instaladores Mac e cria a Release com os arquivos prontos para download.
