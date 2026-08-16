import QRCode from 'qrcode';
import { AppError, type ReceiveInfoDto } from '@wallet/shared';
import { networkLabel } from '@wallet/blockchain';
import { opsRepo, walletsRepo } from '@wallet/db';
import { asUser, type ServiceContext } from './base.js';
import { toAssetDto, toWalletDto } from '../mappers.js';

/**
 * Receive screen data.
 *
 * The QR is rendered **server-side as an SVG data URI** rather than in the browser. Two
 * reasons: no QR library in the client bundle, and the encoded string is guaranteed to be
 * the address the server validated — a client-side renderer could be fed a different value
 * by injected script.
 */
export class ReceiveService {
  async info(
    context: ServiceContext,
    params: { walletId: string; assetId: string },
  ): Promise<ReceiveInfoDto> {
    const { wallet, asset } = await asUser(context, async (tx) => {
      const walletRow = await walletsRepo.findWallet(tx, context.actor.userId, params.walletId);
      if (!walletRow) throw new AppError('WALLET_NOT_FOUND');

      const assetRow = await opsRepo.findAsset(tx, params.assetId);
      if (!assetRow) throw new AppError('ASSET_NOT_FOUND');
      if (assetRow.network !== walletRow.network || assetRow.env !== walletRow.env) {
        throw new AppError('ASSET_NOT_SUPPORTED', {
          details: { reason: 'asset does not belong to the wallet network' },
        });
      }
      return { wallet: walletRow, asset: assetRow };
    });

    const svg = await QRCode.toString(wallet.address, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
      color: { dark: '#000000', light: '#ffffff' },
    });

    return {
      wallet: toWalletDto(wallet, { degradedAfterSeconds: 900 }),
      asset: toAssetDto(asset),
      address: wallet.address,
      // base64 rather than a raw `data:image/svg+xml,` payload so the markup cannot be
      // reinterpreted by a URL parser along the way.
      qrSvgDataUri: `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`,
      networkLabel: networkLabel(wallet.network, wallet.env),
      warningKey: 'receive.networkWarning',
    };
  }
}
