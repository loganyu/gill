// TODO: Replace any with inferred types.

"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationOptions,
  type UseQueryOptions,
} from "@tanstack/react-query";
import type { Account, Address, Instruction } from "gill";

import { GILL_HOOK_CLIENT_KEY } from "../const.js";

type InstructionBuilder<TInput = any> = (input: TInput, config?: { programAddress?: Address }) => Instruction;

type AccountFetcher<TData = any> = (rpc: any, address: Address, config?: any) => Promise<TData>;

type SignAndSendFn = (instruction: Instruction, signer: any) => Promise<string>;

type ProgramHookConfig<
  TInstructions extends Record<string, InstructionBuilder<any>>,
  TAccounts extends Record<string, AccountFetcher<any>>,
> = {
  accounts: TAccounts;
  instructions: TInstructions;
  programAddress?: Address;
  signAndSend: SignAndSendFn;
};

type UseProgramMutationInput<
  TInstructions extends Record<string, InstructionBuilder<any>>,
  TAccounts extends Record<string, AccountFetcher<any>>,
  TInstructionName extends keyof TInstructions,
> = Omit<
  UseMutationOptions<string, Error, Parameters<TInstructions[TInstructionName]>[0] & { signer: any }>,
  "mutationFn"
> & {
  instruction: TInstructionName;
  accounts?: {
    [K in keyof TAccounts]?: Parameters<TAccounts[K]>[0];
  } & Record<string, any>; // Allow additional accounts beyond the defined ones
};

type UseProgramQueryInput<
  TAccounts extends Record<string, AccountFetcher<any>>,
  TAccountName extends keyof TAccounts,
> = Omit<UseQueryOptions<Awaited<ReturnType<TAccounts[TAccountName]>>, Error>, 'queryKey' | 'queryFn'> & {
  account: TAccountName;
  address: Address;
  rpc: Parameters<TAccounts[TAccountName]>[0];
};

export function createProgramHook<
  TInstructions extends Record<string, InstructionBuilder<any>>,
  TAccounts extends Record<string, AccountFetcher<any>>,
>(config: ProgramHookConfig<TInstructions, TAccounts>) {
  const refetchDelay = 1000;

  function useProgramMutation<TInstructionName extends keyof TInstructions>(
    input: UseProgramMutationInput<TInstructions, TAccounts, TInstructionName>,
  ) {
    const queryClient = useQueryClient();
    const { instruction, accounts, ...options } = input;
    const instructionFn = config.instructions[instruction];

    return useMutation({
      ...options,
      mutationFn: async (instructionInput: Parameters<TInstructions[TInstructionName]>[0] & { signer: any }) => {
        const { signer, ...instructionParams } = instructionInput;
        const finalInput = { ...instructionParams, ...(accounts || {}) };

        const instruction = instructionFn(finalInput, {
          programAddress: config.programAddress,
        });

        // Get affected account addresses for query invalidation
        const affectedAddresses = instruction.accounts?.map((account: Account) => account.address) || [];

        console.log("[createProgramHook] Affected addresses:", affectedAddresses);

        // Cancel any outgoing refetches for affected accounts
        await Promise.all(
          affectedAddresses.map((address: Address) =>
            queryClient.cancelQueries({
              queryKey: [GILL_HOOK_CLIENT_KEY, "account"],
              predicate: (query) => {
                const queryKey = query.queryKey as string[];
                return queryKey.includes(address);
              },
            }),
          ),
        );

        console.log("[createProgramHook] Sending transaction...");
        const signature = await config.signAndSend(instruction, signer);
        console.log("[createProgramHook] Transaction sent:", signature);

        await new Promise((resolve) => setTimeout(resolve, refetchDelay));

        console.log("[createProgramHook] Refetching queries...");
        await Promise.all(
          affectedAddresses.map(async (address: Address) => {
            const result = await queryClient.refetchQueries({
              queryKey: [GILL_HOOK_CLIENT_KEY, "account"],
              predicate: (query) => {
                const queryKey = query.queryKey as string[];
                const matches = queryKey.includes(address);
                if (matches) {
                  console.log("[createProgramHook] Refetching query:", queryKey);
                }
                return matches;
              },
              type: "active",
            });
            console.log("[createProgramHook] Refetch result for", address, ":", result);
            return result;
          }),
        );

        console.log("[createProgramHook] Refetch complete");

        return signature;
      },
    });
  }

  function useProgramQuery<TAccountName extends keyof TAccounts>(input: UseProgramQueryInput<TAccounts, TAccountName>) {
    const { account, address, rpc, ...options } = input;
    const accountFetcher = config.accounts[account];

    return useQuery({
      ...options,
      queryKey: [GILL_HOOK_CLIENT_KEY, "account", account, address],
      queryFn: async () => {
        console.log("[useProgramQuery] Fetching account:", account, address);
        const data = await accountFetcher(rpc, address);
        console.log("[useProgramQuery] Fetched data:", data);
        return data;
      },
      enabled: options.enabled !== false && !!address && !!rpc,
      staleTime: options.staleTime ?? 1000,
    });
  }

  return {
    useProgramMutation,
    useProgramQuery,
  };
}
