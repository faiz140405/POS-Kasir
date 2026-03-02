import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';

function makeCode() {
  // contoh: POS-20260302-224500
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `POS-${y}${m}${d}-${hh}${mm}${ss}`;
}

@Injectable()
export class OrderService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateOrderDto) {
    if (!dto.items?.length) throw new BadRequestException('Items is required');

    // Ambil semua produk
    const productIds = dto.items.map(i => i.productId);
    const products = await this.prisma.product.findMany({ where: { id: { in: productIds } } });

    if (products.length !== productIds.length) {
      throw new NotFoundException('One or more products not found');
    }

    // Hitung total + validasi stok
    const itemsComputed = dto.items.map(i => {
      const p = products.find(x => x.id === i.productId)!;
      if (!p.isActive) throw new BadRequestException(`Product inactive: ${p.name}`);
      if (p.stock < i.qty) throw new BadRequestException(`Stock not enough: ${p.name}`);
      const subtotal = p.price * i.qty;
      return { productId: p.id, qty: i.qty, price: p.price, subtotal };
    });

    const total = itemsComputed.reduce((acc, x) => acc + x.subtotal, 0);
    if (dto.paid < total) throw new BadRequestException('Paid is less than total');

    const change = dto.paid - total;

    // Transaksi DB (atomic)
    return this.prisma.$transaction(async (tx) => {
      // Buat order
      const order = await tx.order.create({
        data: {
          code: makeCode(),
          total,
          paid: dto.paid,
          change,
          items: {
            create: itemsComputed,
          },
        },
        include: { items: { include: { product: true } } },
      });

      // Kurangi stok
      for (const it of itemsComputed) {
        await tx.product.update({
          where: { id: it.productId },
          data: { stock: { decrement: it.qty } },
        });
      }

      return order;
    });
  }

  async findAll() {
    return this.prisma.order.findMany({
      orderBy: { id: 'desc' },
      include: { items: { include: { product: true } } },
    });
  }
}