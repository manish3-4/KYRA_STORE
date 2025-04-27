import { stripe } from "../app";
import prisma from "../prismaClient/prismaClient";
import { CustomRequest } from "../types/customRequest";
import { ApiError } from "../utils/ApiError";
import { ApiResponse } from "../utils/ApiResponse";
import { asyncHandler } from "../utils/asyncHandler";

interface ColorType {
  id: number;
  name: string;
}
interface SizeType {
  name: string;
  id: number;
}
interface CartItem {
  id: number; //variantId
  productId: number;
  slug: string;
  color: ColorType;
  size: SizeType;
  name: string;
  price: number;
  quantity: number;
  image: string;
  totalPrice: number;
}

export const createOrder = asyncHandler(async (req: CustomRequest, res) => {
  const {
    addressId,
    cartItems,
    totalAmount,
  }: { addressId: number; cartItems: CartItem[]; totalAmount: number } =
    req.body;

  // Validate input
  if (!addressId || !totalAmount || !cartItems || !cartItems.length) {
    throw new ApiError(400, "All fields are required");
  }

  // 1. Fetch the shipping address
  const shippingAddress = await prisma.shippingAddress.findUnique({
    where: { id: addressId },
  });
  if (!shippingAddress) {
    throw new ApiError(404, "Address not found");
  }

  // 2. Fetch the productVariants in the cart
  const productVariantIds = cartItems.map((item) => item.id);
  const productVariants = await prisma.productVariant.findMany({
    where: {
      id: { in: productVariantIds },
    },
  });

  if (productVariants.length !== cartItems.length) {
    throw new ApiError(404, "One or more productVariants not found");
  }

  // 3. Validate product stock and calculate total
  let calculatedTotal = 0;
  for (const item of cartItems) {
    const product = productVariants.find((p) => p.id === item.id);

    if (
      !product ||
      !product.stockQuantity ||
      product.stockQuantity < item.quantity
    ) {
      throw new ApiError(
        400,
        `Product with ID ${item.id} is unavailable or has insufficient stock`
      );
    }
    // If the product has a sale price, use it
    const productPrice = product.price || 0;
    calculatedTotal += productPrice * item.quantity;
  }

  // 4. Ensure the total amount matches the cart calculation
  if (calculatedTotal !== totalAmount) {
    throw new ApiError(
      400,
      "Total amount does not match the sum of cart items"
    );
  }

  // 5. Create an order in the database (with PENDING status)
  const unpaidOrder = await prisma.order.create({
    data: {
      userId: req?.user?.id as number,
      orderStatus: "INPROCESS",
      paymentStatus: "PENDING",
      shippingAddressId: shippingAddress.id,
      totalAmount,
      items: {
        create: cartItems.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
          priceAtPurchase: item.totalPrice,
          productVariantId: item.id,
        })),
      },
    },
  });

  // 6. Create a Stripe checkout session
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    line_items: cartItems.map((item) => ({
      price_data: {
        currency: "inr",
        product_data: {
          name: item.name,
          images: [item.image],
          metadata: {
            size: item.size.name,
            color: item.color.name,
          },
        },
        unit_amount: item.price * 100,
      },
      quantity: item.quantity,
    })),
    mode: "payment",
    metadata: {
      orderId: unpaidOrder.id,
    },
    customer_email: req.user?.email,
    success_url: `${process.env.CORS_ORIGIN}/orders?status=success`,
    cancel_url: `${process.env.CORS_ORIGIN}/orders?status=failed`,
    expires_at: Math.floor(Date.now() / 1000) + 1800,
  });

  // 7. Update the order with Stripe checkout session ID
  await prisma.order.update({
    where: { id: unpaidOrder.id },
    data: {
      stripeCheckoutId: session.id,
    },
  });

  // 8. Return the session ID to the frontend
  return res
    .status(200)
    .json(
      new ApiResponse(200, { sessionId: session.id }, "Stripe session created")
    );
});

export const getAllUserOrders = asyncHandler(
  async (req: CustomRequest, res) => {
    const userId = req?.user?.id;

    const orders = await prisma.order.findMany({
      where: {
        userId,
      },
      select: {
        id: true,
        orderStatus: true,
        totalAmount: true,
        items: {
          select: {
            id: true,
            priceAtPurchase: true,
            quantity: true,
            product: {
              select: {
                name: true,
                brand: true,
                productImage: true,
              },
            },
            productVariant: {
              select: {
                price: true,
                size: {
                  select: {
                    name: true,
                    id: true,
                  },
                },
                color: {
                  select: {
                    id: true,
                    name: true,
                    images: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (!orders || orders.length === 0) {
      throw new ApiError(404, "No orders found");
    }

    // Transform the data structure
    const transformedOrders = orders.map((order) => ({
      id: order.id,
      orderStatus: order.orderStatus,
      totalAmount: order.totalAmount,
      items: order.items.map((item) => {
        const variantColorId = item.productVariant.color?.id;
        // Retrieve the main image based on the color of the product variant
        const mainImage = variantColorId
          ? item.product.productImage.find(
              (image) => image.colorId === variantColorId && image.isMainImage
            )?.url
          : item.product.productImage.find((image) => image.isMainImage)?.url;

        console.log(variantColorId, mainImage);
        return {
          id: item.id,
          quantity: item.quantity,
          name: item.product.name,
          brand: item.product.brand,
          price: item.productVariant.price,
          size: item.productVariant.size?.name,
          mainImage,
        };
      }),
    }));

    return res
      .status(200)
      .json(new ApiResponse(200, transformedOrders, "All orders fetched"));
  }
);

export const getOrderDetailsById = asyncHandler(
  async (req: CustomRequest, res) => {
    const { id } = req.params;
    const userId = req?.user?.id;

    if (!id) {
      throw new ApiError(400, "Id is required");
    }

    const order = await prisma.order.findUnique({
      where: {
        id: Number(id),
        userId,
      },
      select: {
        id: true,
        orderStatus: true,
        createdAt: true,
        totalAmount: true,
        shippingAddress: {
          select: {
            id: true,
            fullName: true,
            phone: true,
            addressLine1: true,
            city: true,
            state: true,
            pincode: true,
          },
        },
        items: {
          select: {
            id: true,
            priceAtPurchase: true,
            quantity: true,
            product: {
              select: {
                id: true,
                name: true,
                productImage: true,
              },
            },
            productVariant: {
              select: {
                id: true,
                price: true,
                color: {
                  select: {
                    id: true,
                  },
                },
                size: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    const formatedOrder = {
      id: order?.id,
      orderStatus: order?.orderStatus,
      orderDate: order?.createdAt,
      totalAmount: order?.totalAmount,
      items: order?.items.map((item) => {
        const variantColorId = item.productVariant.color?.id;
        const mainImage = variantColorId
          ? item.product.productImage.find(
              (image) => image.colorId === variantColorId && image.isMainImage
            )?.url
          : item.product.productImage.find((image) => image.isMainImage)?.url;

        return {
          id: item.productVariant.id,
          name: item.product.name,
          price: item.productVariant.price,
          quantity: item.quantity,
          mainImage: mainImage,
          size: item.productVariant.size?.name,
        };
      }),
      shippingAddress: {
        id: order?.shippingAddress.id,
        phone: order?.shippingAddress.phone,
        addressLine1: order?.shippingAddress.addressLine1,
        postalCode: order?.shippingAddress.pincode,
        city: order?.shippingAddress.city,
        state: order?.shippingAddress.state,
        fullName: order?.shippingAddress.fullName,
        country: "USA",
      },
    };

    res
      .status(200)
      .json(new ApiResponse(200, formatedOrder, "Order details fetched"));
  }
);

export const getAllOrders = asyncHandler(async (req, res) => {
  const orders = await prisma.order.findMany({
    select: {
      id: true,
      user: {
        select: {
          firstName: true,
          lastName: true,
        },
      },
      orderStatus: true,
      paymentStatus: true,
      totalAmount: true,
      createdAt: true,
    },
  });

  return res
    .status(200)
    .json(new ApiResponse(200, orders, "All Order fetched"));
});
